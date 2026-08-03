/**
 * `gms db` — migrate, status, vacuum, backup.
 */
import path from 'node:path';
import type { ResolvedConfig } from '../../config/schema.js';
import { displayPath, resolvePath } from '../../core/util/paths.js';
import { checkIntegrity, describeDatabase, openDatabaseFromConfig } from '../../db/client.js';
import { appliedMigrations, migrate, pendingMigrations } from '../../db/migrate.js';
import { MetaRepository, META_KEYS } from '../../db/repositories/meta.js';
import { APP_VERSION } from '../../version.js';
import { formatBytes, formatDuration, heading, keyValue, style, symbol } from '../output.js';

export interface DbCommandOptions {
  readonly config: ResolvedConfig;
  readonly json?: boolean;
}

export function runDbMigrate(options: DbCommandOptions & { dryRun: boolean }): void {
  const driver = openDatabaseFromConfig(options.config);
  const startedAt = Date.now();
  try {
    const result = migrate(driver, {
      dryRun: options.dryRun,
      onApply: (migration) => {
        if (!options.dryRun) {
          console.log(`  ${symbol.info} applying ${migration.version} ${migration.name}`);
        }
      },
    });

    if (options.dryRun) {
      if (result.applied.length === 0) {
        console.log(`${symbol.ok} database is up to date (${result.alreadyApplied} applied)`);
      } else {
        console.log(`${result.applied.length} migration(s) would be applied:`);
        for (const migration of result.applied) {
          console.log(`  ${style.grey(migration.version)}  ${migration.name}`);
        }
      }
      return;
    }

    // Record identity on first migrate so logs and exports can be correlated
    // back to the database that produced them.
    const meta = new MetaRepository(driver);
    const installId = meta.ensureInstallId();
    meta.set(META_KEYS.appVersion, APP_VERSION);

    if (result.applied.length === 0) {
      console.log(`${symbol.ok} database is up to date (${result.alreadyApplied} applied)`);
    } else {
      console.log(
        `${symbol.ok} applied ${result.applied.length} migration(s) in ${formatDuration(
          Date.now() - startedAt,
        )}`,
      );
    }
    console.log(style.grey(`  database  ${displayPath(driver.file)}`));
    console.log(style.grey(`  install   ${installId}`));
  } finally {
    driver.close();
  }
}

export function runDbStatus(options: DbCommandOptions): void {
  const driver = openDatabaseFromConfig(options.config, { readonly: false });
  try {
    const info = describeDatabase(driver);
    const applied = appliedMigrations(driver);
    const pending = pendingMigrations(driver);
    const meta = new MetaRepository(driver);

    if (options.json === true) {
      console.log(
        JSON.stringify(
          {
            file: info.file,
            sqliteVersion: info.sqliteVersion,
            journalMode: info.journalMode,
            synchronous: info.synchronous,
            sizeBytes: info.sizeBytes,
            installId: meta.get(META_KEYS.installId) ?? null,
            appliedMigrations: applied.map((m) => m.version),
            pendingMigrations: pending.map((m) => m.version),
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      keyValue([
        ['file', displayPath(info.file)],
        ['size', info.sizeBytes === null ? 'n/a' : formatBytes(info.sizeBytes)],
        ['sqlite', info.sqliteVersion],
        ['journal', info.journalMode],
        ['synchronous', info.synchronous],
        ['foreign keys', info.foreignKeys ? 'on' : style.yellow('off')],
        ['page size', formatBytes(info.pageSizeBytes)],
        ['install id', meta.get(META_KEYS.installId) ?? style.grey('(not set)')],
      ]),
    );

    console.log(heading('Migrations'));
    if (applied.length === 0) {
      console.log(`  ${style.grey('none applied')}`);
    }
    for (const row of applied) {
      console.log(
        `  ${symbol.ok} ${row.version}  ${row.name} ${style.grey(
          new Date(row.applied_at).toISOString(),
        )}`,
      );
    }
    for (const row of pending) {
      console.log(`  ${symbol.warn} ${row.version}  ${row.name} ${style.grey('(pending)')}`);
    }
  } finally {
    driver.close();
  }
}

export function runDbVacuum(options: DbCommandOptions): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const before = describeDatabase(driver).sizeBytes;
    const startedAt = Date.now();
    driver.exec('VACUUM');
    const after = describeDatabase(driver).sizeBytes;
    const saved = before !== null && after !== null ? before - after : null;
    console.log(
      `${symbol.ok} vacuumed in ${formatDuration(Date.now() - startedAt)}` +
        (saved === null ? '' : ` ${style.grey(`(reclaimed ${formatBytes(Math.max(saved, 0))})`)}`),
    );
  } finally {
    driver.close();
  }
}

export function runDbBackup(options: DbCommandOptions & { destination: string }): void {
  const driver = openDatabaseFromConfig(options.config, { readonly: false });
  try {
    const destination = resolvePath(options.destination, process.cwd());
    const startedAt = Date.now();
    // VACUUM INTO, not a file copy: a copy taken while a transaction is open
    // captures a torn state, and the -wal/-shm sidecars must travel with the
    // main file or the copy is useless.
    driver.backupTo(destination);
    console.log(
      `${symbol.ok} backed up to ${displayPath(destination)} in ${formatDuration(
        Date.now() - startedAt,
      )}`,
    );
    console.log(style.grey(`  directory  ${displayPath(path.dirname(destination))}`));
  } finally {
    driver.close();
  }
}

export function runDbCheck(options: DbCommandOptions): boolean {
  const driver = openDatabaseFromConfig(options.config, { readonly: true });
  try {
    const problems = checkIntegrity(driver, false);
    if (problems.length === 0) {
      console.log(`${symbol.ok} integrity_check passed`);
      return true;
    }
    console.log(`${symbol.fail} integrity_check reported ${problems.length} problem(s):`);
    for (const problem of problems.slice(0, 20)) {
      console.log(`  ${problem}`);
    }
    return false;
  } finally {
    driver.close();
  }
}
