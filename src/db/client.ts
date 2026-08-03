/**
 * Database lifecycle: open, configure pragmas, verify.
 *
 * Pragmas are applied here and only here, and every one of them is a deliberate
 * choice rather than a copied incantation — see the comments on each.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/schema.js';
import { DatabaseError } from '../core/errors/taxonomy.js';
import { assertSafeDatabasePath } from '../core/util/storage-safety.js';
import { openBetterSqlite3 } from './driver/better-sqlite3.js';
import type { SqliteDriver } from './driver/types.js';

export interface OpenDatabaseOptions {
  readonly file: string;
  readonly wal?: boolean;
  readonly busyTimeoutMs?: number;
  readonly synchronous?: 'OFF' | 'NORMAL' | 'FULL';
  readonly readonly?: boolean;
  /** Skip the network/cloud-sync location check. Only in-memory tests should set this. */
  readonly skipPathSafetyCheck?: boolean;
  readonly allowCloudSync?: boolean;
}

const IN_MEMORY = ':memory:';

/**
 * Open the database and apply pragmas.
 *
 * Ordering matters: `journal_mode` must be set before `synchronous`, because
 * switching to WAL resets `synchronous` to its compile-time default.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDriver {
  const isMemory = options.file === IN_MEMORY;

  if (!isMemory && options.skipPathSafetyCheck !== true) {
    assertSafeDatabasePath(options.file, { allowCloudSync: options.allowCloudSync ?? false });
  }

  if (!isMemory) {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
  }

  const driver = openBetterSqlite3({
    file: options.file,
    ...(options.readonly !== undefined ? { readonly: options.readonly } : {}),
    ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
  });

  try {
    // Referential integrity is off by default in SQLite. Every FK in the schema
    // is load-bearing (a sighting without its business is meaningless), so this
    // is not optional. It is per-connection, not stored in the file.
    driver.setPragma('foreign_keys', true);

    if (options.wal !== false && !isMemory) {
      const mode = driver.setPragma<string>('journal_mode', 'WAL');
      if (typeof mode === 'string' && mode.toLowerCase() !== 'wal') {
        throw new DatabaseError(`Database refused write-ahead logging (journal_mode = ${mode}).`, {
          code: 'DB_OPEN_FAILED',
          hint:
            'This usually means the database is on a filesystem that cannot support WAL, ' +
            'such as a network share. Move it to a local disk.',
        });
      }
    }

    // NORMAL is safe under WAL: a process crash cannot corrupt the database,
    // though a power loss may lose the last transaction. That is the right
    // trade for a resumable scraper — every job is checkpointed and re-runnable,
    // so losing the final commit costs one job, while FULL costs an fsync on
    // every write for the whole run.
    driver.setPragma('synchronous', options.synchronous ?? 'NORMAL');

    // Temp b-trees for ORDER BY and GROUP BY stay in RAM instead of hitting a
    // temp file — meaningful for the reporting queries in `gms status`.
    driver.setPragma('temp_store', 'MEMORY');
  } catch (error) {
    driver.close();
    throw error;
  }

  return driver;
}

/** Open the database described by a resolved config. */
export function openDatabaseFromConfig(
  config: ResolvedConfig,
  overrides: Partial<OpenDatabaseOptions> = {},
): SqliteDriver {
  // Assess the configured value verbatim as well as the resolved path. A UNC
  // path written into a config file on Windows survives into that file, and
  // resolving it on a POSIX host normalizes the leading slashes away — which
  // would hide a network location from the check below.
  if (overrides.skipPathSafetyCheck !== true) {
    assertSafeDatabasePath(config.database.file, {
      allowCloudSync: config.database.allowCloudSync,
    });
  }

  return openDatabase({
    file: config.paths.databaseFile,
    wal: config.database.wal,
    busyTimeoutMs: config.database.busyTimeoutMs,
    synchronous: config.database.synchronous,
    allowCloudSync: config.database.allowCloudSync,
    ...overrides,
  });
}

export interface DatabaseInfo {
  readonly file: string;
  readonly sqliteVersion: string;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly synchronous: string;
  readonly pageSizeBytes: number;
  readonly sizeBytes: number | null;
  readonly userVersion: number;
}

const SYNCHRONOUS_LABELS = ['OFF', 'NORMAL', 'FULL', 'EXTRA'] as const;

/** Report the live pragma state. Used by `gms doctor` and `gms db status`. */
export function describeDatabase(driver: SqliteDriver): DatabaseInfo {
  const synchronousCode = driver.pragma<number>('synchronous');
  let sizeBytes: number | null = null;
  if (driver.file !== IN_MEMORY) {
    try {
      sizeBytes = fs.statSync(driver.file).size;
    } catch {
      sizeBytes = null;
    }
  }

  return {
    file: driver.file,
    sqliteVersion: driver.prepare<{ v: string }>('SELECT sqlite_version() AS v').get()?.v ?? '?',
    journalMode: driver.pragma<string>('journal_mode'),
    foreignKeys: driver.pragma<number>('foreign_keys') === 1,
    synchronous: SYNCHRONOUS_LABELS[synchronousCode] ?? String(synchronousCode),
    pageSizeBytes: driver.pragma<number>('page_size'),
    sizeBytes,
    userVersion: driver.pragma<number>('user_version'),
  };
}

/**
 * Run an integrity check. Returns an empty array when the database is sound.
 *
 * `quick_check` skips the (expensive) index-content cross-check but catches
 * every form of structural corruption, which is what matters operationally.
 */
export function checkIntegrity(driver: SqliteDriver, quick = true): string[] {
  const rows = driver
    .prepare<Record<string, string>>(`PRAGMA ${quick ? 'quick_check' : 'integrity_check'}`)
    .all();
  const messages = rows
    .map((row) => Object.values(row)[0])
    .filter((value): value is string => typeof value === 'string');
  return messages.length === 1 && messages[0] === 'ok' ? [] : messages;
}
