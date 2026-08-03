/**
 * `gms doctor` — verify the environment before a long run fails at hour three.
 *
 * Each check is independent and reports ok / warn / fail with an actionable
 * hint. The command exits non-zero if anything failed, so it can gate a deploy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from '../../config/schema.js';
import { errorMessage } from '../../core/errors/taxonomy.js';
import { displayPath } from '../../core/util/paths.js';
import { assessStoragePath } from '../../core/util/storage-safety.js';
import { checkIntegrity, describeDatabase, openDatabaseFromConfig } from '../../db/client.js';
import { appliedMigrations, loadMigrations } from '../../db/migrate.js';
import { APP_VERSION, REQUIRED_NODE_RANGE } from '../../version.js';
import { formatBytes, keyValue, style, symbol } from '../output.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

/** better-sqlite3 v13 ships prebuilds only for these platform-architecture pairs. */
const PREBUILT_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

function parseMinimumVersion(range: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkNodeVersion(): CheckResult {
  const current = parseMinimumVersion(process.version) ?? [0, 0, 0];
  const required = parseMinimumVersion(REQUIRED_NODE_RANGE);

  if (required === null) {
    return { name: 'Node.js', status: 'ok', detail: process.version };
  }
  if (compareVersions(current, required) < 0) {
    return {
      name: 'Node.js',
      status: 'fail',
      detail: `${process.version} is below the required ${REQUIRED_NODE_RANGE}`,
      hint: 'Install Node 24 LTS. With nvm: `nvm install 24 && nvm use 24`.',
    };
  }
  // Odd-numbered Node releases are never LTS and go end-of-life quickly.
  if (current[0] % 2 !== 0) {
    return {
      name: 'Node.js',
      status: 'warn',
      detail: `${process.version} is a non-LTS release`,
      hint: 'Use an even-numbered LTS line (24) for anything long-running.',
    };
  }
  return {
    name: 'Node.js',
    status: 'ok',
    detail: `${process.version} (requires ${REQUIRED_NODE_RANGE})`,
  };
}

/**
 * Confirm the native SQLite binding actually loaded.
 *
 * This matters because better-sqlite3 v13 sets `gypfile: false`, which disables
 * the node-gyp fallback. On a platform with no bundled prebuild, `npm install`
 * reports success and the failure only appears at require() time — so catching
 * it here with a readable message beats a raw module-load stack trace.
 */
function checkNativeModule(): CheckResult {
  const target = `${process.platform}-${process.arch}`;
  if (!PREBUILT_TARGETS.has(target)) {
    return {
      name: 'SQLite binding',
      status: 'fail',
      detail: `no prebuilt binary for ${target}`,
      hint:
        'better-sqlite3 ships prebuilds for darwin/linux/win32 on x64 and arm64 only. ' +
        'A 32-bit platform needs a source build (Python + a C++ toolchain).',
    };
  }
  return { name: 'SQLite binding', status: 'ok', detail: `prebuilt binary for ${target}` };
}

function checkDataDir(config: ResolvedConfig): CheckResult {
  const dir = config.paths.dataDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { name: 'Data directory', status: 'ok', detail: displayPath(dir) };
  } catch (error) {
    return {
      name: 'Data directory',
      status: 'fail',
      detail: `${displayPath(dir)} is not writable: ${errorMessage(error)}`,
      hint: 'Check permissions, or point project.dataDir somewhere writable.',
    };
  }
}

function checkDatabaseLocation(config: ResolvedConfig): CheckResult {
  const assessment = assessStoragePath(config.paths.databaseFile);
  const where = displayPath(config.paths.databaseFile);

  switch (assessment.risk) {
    case 'network':
      return {
        name: 'Database location',
        status: 'fail',
        detail: `${where} — ${assessment.detail}`,
        hint:
          'SQLite cannot use write-ahead logging over a network filesystem, and its locking ' +
          'is unreliable there. Move the database to a local disk.',
      };
    case 'cloud-sync':
      return {
        name: 'Database location',
        status: config.database.allowCloudSync ? 'warn' : 'fail',
        detail: `${where} — ${assessment.detail}`,
        hint:
          'Sync agents copy the file mid-transaction and sync the -wal/-shm sidecars ' +
          'separately, which corrupts copies and can clobber the live database. ' +
          'Move it outside the synced folder.',
      };
    case 'safe':
      return { name: 'Database location', status: 'ok', detail: where };
  }
}

/**
 * On Windows a mapped drive letter is indistinguishable from a local disk
 * without a Win32 call, so it cannot be detected from the path alone. Say so
 * rather than implying the location check covers it.
 */
function checkWindowsMappedDrive(config: ResolvedConfig): CheckResult | null {
  if (process.platform !== 'win32') return null;
  const drive = /^([A-Za-z]):/.exec(config.paths.databaseFile)?.[1];
  if (drive === undefined) return null;
  return {
    name: 'Drive type',
    status: 'warn',
    detail: `cannot verify that ${drive}: is a local disk`,
    hint: `Run \`net use\` — if ${drive}: is a mapped network drive, move the database to a local disk.`,
  };
}

function checkDatabase(config: ResolvedConfig): CheckResult[] {
  const results: CheckResult[] = [];
  let driver;
  try {
    driver = openDatabaseFromConfig(config);
  } catch (error) {
    return [
      {
        name: 'Database',
        status: 'fail',
        detail: errorMessage(error),
        hint: 'Run `gms db migrate` to create it.',
      },
    ];
  }

  try {
    const info = describeDatabase(driver);
    results.push({
      name: 'Database',
      status: 'ok',
      detail: `SQLite ${info.sqliteVersion}, journal=${info.journalMode}, ${
        info.sizeBytes === null ? 'new' : formatBytes(info.sizeBytes)
      }`,
    });

    if (config.database.wal && info.journalMode.toLowerCase() !== 'wal') {
      results.push({
        name: 'Write-ahead log',
        status: 'fail',
        detail: `journal_mode is ${info.journalMode}, expected wal`,
        hint: 'The filesystem may not support WAL. Move the database to a local disk.',
      });
    }

    // Prove RETURNING works on this build. Job leasing depends on it, and it
    // needs SQLite >= 3.35 — cheaper to find out now than at first run.
    try {
      driver.exec('CREATE TEMP TABLE _doctor_probe (id INTEGER PRIMARY KEY, v TEXT)');
      const row = driver
        .prepare<{ id: number }>(`INSERT INTO _doctor_probe (v) VALUES (?) RETURNING id`)
        .get(['x']);
      results.push(
        row?.id === 1
          ? { name: 'RETURNING support', status: 'ok', detail: 'atomic job leasing available' }
          : {
              name: 'RETURNING support',
              status: 'fail',
              detail: 'RETURNING did not return a row',
              hint: 'SQLite 3.35 or newer is required.',
            },
      );
      driver.exec('DROP TABLE _doctor_probe');
    } catch (error) {
      results.push({
        name: 'RETURNING support',
        status: 'fail',
        detail: errorMessage(error),
        hint: 'SQLite 3.35 or newer is required for atomic job leasing.',
      });
    }

    const problems = checkIntegrity(driver);
    results.push(
      problems.length === 0
        ? { name: 'Integrity', status: 'ok', detail: 'quick_check passed' }
        : {
            name: 'Integrity',
            status: 'fail',
            detail: problems.slice(0, 3).join('; '),
            hint: 'Restore from a backup taken with `gms db backup`.',
          },
    );

    const migrations = loadMigrations();
    const applied = new Set(appliedMigrations(driver).map((m) => m.version));
    const pending = migrations.filter((m) => !applied.has(m.version));
    results.push(
      pending.length === 0
        ? {
            name: 'Migrations',
            status: 'ok',
            detail: `${applied.size} applied, up to date`,
          }
        : {
            name: 'Migrations',
            status: 'warn',
            detail: `${pending.length} pending (${pending.map((m) => m.version).join(', ')})`,
            hint: 'Run `gms db migrate`.',
          },
    );
  } catch (error) {
    results.push({ name: 'Database', status: 'fail', detail: errorMessage(error) });
  } finally {
    driver.close();
  }

  return results;
}

export interface DoctorOptions {
  readonly config: ResolvedConfig;
  readonly json: boolean;
}

export function runDoctor(options: DoctorOptions): { results: CheckResult[]; failed: boolean } {
  const { config } = options;

  const results: CheckResult[] = [
    checkNodeVersion(),
    checkNativeModule(),
    checkDataDir(config),
    checkDatabaseLocation(config),
  ];

  const mappedDrive = checkWindowsMappedDrive(config);
  if (mappedDrive !== null) results.push(mappedDrive);

  results.push(...checkDatabase(config));

  const failed = results.some((r) => r.status === 'fail');

  if (options.json) {
    console.log(JSON.stringify({ ok: !failed, version: APP_VERSION, checks: results }, null, 2));
    return { results, failed };
  }

  console.log(
    keyValue([
      ['gms', APP_VERSION],
      ['platform', `${os.type()} ${os.release()} (${process.platform}-${process.arch})`],
      ['config', config.sources.map((s) => s.detail).join(' -> ')],
    ]),
  );
  console.log('');

  const width = results.reduce((max, r) => Math.max(max, r.name.length), 0);
  for (const result of results) {
    const mark =
      result.status === 'ok' ? symbol.ok : result.status === 'warn' ? symbol.warn : symbol.fail;
    console.log(`  ${mark} ${result.name.padEnd(width)}  ${result.detail}`);
    if (result.hint !== undefined && result.status !== 'ok') {
      console.log(`      ${style.grey(result.hint)}`);
    }
  }

  console.log('');
  console.log(
    failed
      ? `${symbol.fail} ${style.red('some checks failed')}`
      : `${symbol.ok} ${style.green('all checks passed')}`,
  );

  return { results, failed };
}

// Re-exported for tests that assert on individual checks.
export const _internal = { checkNodeVersion, checkNativeModule, checkDatabaseLocation };
