/**
 * Migration runner.
 *
 * Plain, ordered `.sql` files applied inside a transaction and recorded in
 * `schema_migrations`. No ORM involvement: migrations outlive whichever query
 * builder is fashionable, and raw SQL is what you want to read at 3am.
 *
 * Guarantees:
 *  - Idempotent. Running twice applies nothing the second time.
 *  - Atomic per migration. A failure rolls that file back entirely, so the
 *    database is never left half-migrated.
 *  - Tamper-evident. Each applied file's checksum is stored; editing a migration
 *    that has already run is an error rather than a silent divergence.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseError } from '../core/errors/taxonomy.js';
import { moduleDir } from '../core/util/paths.js';
import type { SqliteDriver } from './driver/types.js';

export interface Migration {
  /** Zero-padded ordering prefix, e.g. `0001`. */
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: number;
}

const FILENAME_PATTERN = /^(\d{4,})_([a-z0-9_-]+)\.sql$/i;

/**
 * Locate the bundled `migrations/` directory.
 *
 * Resolved relative to this module rather than `process.cwd()` so the CLI works
 * from any directory, and identically whether running from `src` via tsx or
 * from `dist` after a build.
 */
export function defaultMigrationsDir(): string {
  // src/db/migrate.ts -> ../../migrations ; dist/db/migrate.js -> ../../migrations
  return path.resolve(moduleDir(import.meta.url), '..', '..', 'migrations');
}

function checksum(sql: string): string {
  // Normalize line endings so a checkout with CRLF does not appear to be tampered with.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 32);
}

/** Read and validate the migration files, sorted by version. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
  if (!fs.existsSync(dir)) {
    throw new DatabaseError(`Migrations directory not found: ${dir}`, {
      code: 'DB_MIGRATION_FAILED',
      hint: 'The installation looks incomplete — the bundled migrations/ folder is missing.',
    });
  }

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const filename of fs.readdirSync(dir).sort()) {
    if (!filename.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new DatabaseError(`Migration filename is malformed: ${filename}`, {
        code: 'DB_MIGRATION_FAILED',
        hint: 'Expected <version>_<name>.sql, for example 0002_add_jobs.sql',
      });
    }
    const version = match[1]!;
    const name = match[2]!;

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new DatabaseError(
        `Duplicate migration version ${version}: ${duplicate} and ${filename}`,
        { code: 'DB_MIGRATION_FAILED' },
      );
    }
    seen.set(version, filename);

    const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
    migrations.push({ version, name, filename, sql, checksum: checksum(sql) });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

function ensureBookkeepingTable(driver: SqliteDriver): void {
  // Created outside the migration sequence, since it is what records that
  // sequence. STRICT gives real column typing rather than SQLite's default
  // permissive affinity.
  driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
}

export function appliedMigrations(driver: SqliteDriver): AppliedMigration[] {
  ensureBookkeepingTable(driver);
  return driver
    .prepare<AppliedMigration>(
      `SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`,
    )
    .all();
}

export interface MigrateResult {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
  readonly currentVersion: string | null;
}

export interface MigrateOptions {
  readonly dir?: string;
  /** Report what would run without changing anything. */
  readonly dryRun?: boolean;
  /** Called before each migration is applied. For CLI progress output. */
  readonly onApply?: (migration: Migration) => void;
}

/**
 * Bring the database up to the latest schema version.
 *
 * @throws {DatabaseError} if an applied migration's checksum no longer matches
 * its file, or if a migration fails. Both leave the database consistent.
 */
export function migrate(driver: SqliteDriver, options: MigrateOptions = {}): MigrateResult {
  const migrations = loadMigrations(options.dir);
  ensureBookkeepingTable(driver);

  const applied = new Map(appliedMigrations(driver).map((row) => [row.version, row]));

  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record !== undefined && record.checksum !== migration.checksum) {
      throw new DatabaseError(`Migration ${migration.filename} has changed since it was applied.`, {
        code: 'DB_MIGRATION_FAILED',
        hint:
          'Applied migrations are immutable. Revert the edit and add a new migration ' +
          'file with the change instead.',
        details: { expected: record.checksum, actual: migration.checksum },
      });
    }
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (options.dryRun === true) {
    return {
      applied: pending,
      alreadyApplied: applied.size,
      currentVersion: migrations.at(-1)?.version ?? null,
    };
  }

  const done: Migration[] = [];
  for (const migration of pending) {
    options.onApply?.(migration);
    try {
      // IMMEDIATE takes the write lock up front. A deferred transaction that
      // reads before writing has to promote, which under WAL can fail with
      // SQLITE_BUSY_SNAPSHOT that the busy timeout will not retry.
      driver.transaction(() => {
        driver.exec(migration.sql);
        driver
          .prepare(
            `INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run([migration.version, migration.name, migration.checksum, Date.now()]);
      }, 'immediate');
    } catch (cause) {
      throw new DatabaseError(`Migration ${migration.filename} failed and was rolled back.`, {
        code: 'DB_MIGRATION_FAILED',
        details: { version: migration.version },
        cause,
      });
    }
    done.push(migration);
  }

  return {
    applied: done,
    alreadyApplied: applied.size,
    currentVersion: migrations.at(-1)?.version ?? null,
  };
}

/** Versions present in the directory but not yet applied. */
export function pendingMigrations(driver: SqliteDriver, dir?: string): Migration[] {
  const migrations = loadMigrations(dir);
  const applied = new Set(appliedMigrations(driver).map((row) => row.version));
  return migrations.filter((m) => !applied.has(m.version));
}
