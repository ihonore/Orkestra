import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import {
  checkIntegrity,
  describeDatabase,
  openDatabase,
  openDatabaseFromConfig,
} from '../src/db/client.js';
import {
  appliedMigrations,
  loadMigrations,
  migrate,
  pendingMigrations,
} from '../src/db/migrate.js';
import { META_KEYS, MetaRepository } from '../src/db/repositories/meta.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

afterEach(cleanupTempDirs);

function freshDb(): { driver: SqliteDriver; dir: string } {
  const dir = tempDir();
  const driver = openDatabase({ file: path.join(dir, 'test.sqlite') });
  return { driver, dir };
}

describe('database pragmas', () => {
  it('enables WAL and foreign keys', () => {
    const { driver } = freshDb();
    try {
      const info = describeDatabase(driver);
      expect(info.journalMode.toLowerCase()).toBe('wal');
      expect(info.foreignKeys).toBe(true);
      expect(info.synchronous).toBe('NORMAL');
    } finally {
      driver.close();
    }
  });

  it('honours a FULL synchronous setting', () => {
    const dir = tempDir();
    const driver = openDatabase({ file: path.join(dir, 'x.sqlite'), synchronous: 'FULL' });
    try {
      expect(describeDatabase(driver).synchronous).toBe('FULL');
    } finally {
      driver.close();
    }
  });

  it('actually enforces foreign keys, rather than merely reporting them on', () => {
    const { driver } = freshDb();
    try {
      driver.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `);
      expect(() =>
        driver.prepare('INSERT INTO child (parent_id) VALUES (?)').run([999]),
      ).toThrowError(/FOREIGN KEY/i);
    } finally {
      driver.close();
    }
  });

  it('refuses a database on a network path', () => {
    expect(() => openDatabase({ file: '\\\\server\\share\\gms.sqlite' })).toThrowError(
      /network filesystem/,
    );
  });

  it('refuses a UNC path written in the config even on a POSIX host', () => {
    // Resolving `\\server\share` on POSIX would hide it, so the raw configured
    // value is checked too. This is the "config authored on the Windows VPS,
    // opened on the Mac" case.
    const dir = tempDir();
    const config = loadConfig({ cwd: dir, env: {} });
    const withUnc = {
      ...config,
      database: { ...config.database, file: '\\\\server\\share\\gms.sqlite' },
    };

    expect(() => openDatabaseFromConfig(withUnc)).toThrowError(/network filesystem/);
  });
});

describe('RETURNING', () => {
  it('yields the row through get() — the leasing pattern', () => {
    const { driver } = freshDb();
    try {
      driver.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT, owner TEXT)');
      driver.prepare("INSERT INTO jobs (status) VALUES ('pending')").run();

      const claimed = driver
        .prepare<{ id: number; owner: string }>(
          `UPDATE jobs SET status='leased', owner=?
            WHERE id = (SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT 1)
            RETURNING *`,
        )
        .get(['worker-1']);

      expect(claimed?.id).toBe(1);
      expect(claimed?.owner).toBe('worker-1');
    } finally {
      driver.close();
    }
  });

  it('returns undefined when the queue is empty, rather than throwing', () => {
    const { driver } = freshDb();
    try {
      driver.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT)');
      const claimed = driver
        .prepare(
          `UPDATE jobs SET status='leased'
            WHERE id = (SELECT id FROM jobs WHERE status='pending' LIMIT 1) RETURNING *`,
        )
        .get();
      expect(claimed).toBeUndefined();
    } finally {
      driver.close();
    }
  });

  it('discards RETURNING rows when run() is used — the documented footgun', () => {
    // Guards the comment in driver/types.ts. If a future driver swap changes
    // this, the leasing code must be revisited, not silently inherited.
    const { driver } = freshDb();
    try {
      driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      const result = driver.prepare('INSERT INTO t (v) VALUES (?) RETURNING id').run(['x']);
      expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(result).not.toHaveProperty('id');
    } finally {
      driver.close();
    }
  });

  it('leases each row to exactly one caller under repeated concurrent claims', () => {
    const { driver } = freshDb();
    try {
      // A recursive CTE rather than generate_series(): the series extension is
      // not compiled into every SQLite build, and portability is the point here.
      driver.exec(`
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, owner TEXT);
        INSERT INTO jobs (status)
          WITH RECURSIVE seq(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200
          )
          SELECT 'pending' FROM seq;
      `);
      const claim = driver.prepare<{ id: number }>(
        `UPDATE jobs SET status='leased', owner=?
          WHERE id = (SELECT id FROM jobs WHERE status='pending' ORDER BY id LIMIT 1)
          RETURNING id`,
      );

      const seen = new Set<number>();
      for (let i = 0; i < 250; i += 1) {
        const row = claim.get([`worker-${i % 8}`]);
        if (row === undefined) break;
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }

      expect(seen.size).toBe(200);
      const remaining = driver
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'")
        .get();
      expect(remaining?.n).toBe(0);
    } finally {
      driver.close();
    }
  });
});

describe('transactions', () => {
  it('rolls back every statement when the callback throws', () => {
    const { driver } = freshDb();
    try {
      driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      expect(() =>
        driver.transaction(() => {
          driver.prepare('INSERT INTO t (v) VALUES (?)').run(['a']);
          driver.prepare('INSERT INTO t (v) VALUES (?)').run(['b']);
          throw new Error('boom');
        }),
      ).toThrowError('boom');

      const count = driver.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get();
      expect(count?.n).toBe(0);
    } finally {
      driver.close();
    }
  });

  it('commits on normal return', () => {
    const { driver } = freshDb();
    try {
      driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      driver.transaction(() => {
        driver.prepare('INSERT INTO t (v) VALUES (?)').run(['a']);
      });
      expect(driver.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t').get()?.n).toBe(1);
    } finally {
      driver.close();
    }
  });
});

describe('migrations', () => {
  it('applies the bundled migrations and records them', () => {
    const { driver } = freshDb();
    try {
      const result = migrate(driver);
      expect(result.applied.length).toBeGreaterThan(0);
      expect(appliedMigrations(driver).map((m) => m.version)).toEqual(
        loadMigrations().map((m) => m.version),
      );
    } finally {
      driver.close();
    }
  });

  it('is idempotent', () => {
    const { driver } = freshDb();
    try {
      const first = migrate(driver);
      const second = migrate(driver);
      expect(second.applied).toHaveLength(0);
      expect(second.alreadyApplied).toBe(first.applied.length);
      expect(pendingMigrations(driver)).toHaveLength(0);
    } finally {
      driver.close();
    }
  });

  it('reports pending work without applying it in dry-run mode', () => {
    const { driver } = freshDb();
    try {
      const planned = migrate(driver, { dryRun: true });
      expect(planned.applied.length).toBeGreaterThan(0);
      expect(appliedMigrations(driver)).toHaveLength(0);
    } finally {
      driver.close();
    }
  });

  it('detects an edit to an already-applied migration', () => {
    const { driver, dir } = freshDb();
    const migrationsDir = path.join(dir, 'migrations');
    writeFile(migrationsDir, '0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');

    try {
      migrate(driver, { dir: migrationsDir });
      writeFile(migrationsDir, '0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);');

      expect(() => migrate(driver, { dir: migrationsDir })).toThrowError(/has changed/);
    } finally {
      driver.close();
    }
  });

  it('rolls a failing migration back entirely, leaving the database consistent', () => {
    const { driver, dir } = freshDb();
    const migrationsDir = path.join(dir, 'migrations');
    writeFile(migrationsDir, '0001_ok.sql', 'CREATE TABLE good (id INTEGER PRIMARY KEY);');
    writeFile(
      migrationsDir,
      '0002_bad.sql',
      'CREATE TABLE fine (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;',
    );

    try {
      expect(() => migrate(driver, { dir: migrationsDir })).toThrowError(/0002_bad\.sql failed/);

      const applied = appliedMigrations(driver).map((m) => m.version);
      expect(applied).toEqual(['0001']);

      // The first statement of the failed migration must not have survived.
      const tables = driver
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      expect(tables).toContain('good');
      expect(tables).not.toContain('fine');
    } finally {
      driver.close();
    }
  });

  it('rejects a malformed migration filename', () => {
    const { driver, dir } = freshDb();
    const migrationsDir = path.join(dir, 'migrations');
    writeFile(migrationsDir, 'add-stuff.sql', 'SELECT 1;');
    try {
      expect(() => migrate(driver, { dir: migrationsDir })).toThrowError(/malformed/);
    } finally {
      driver.close();
    }
  });

  it('rejects two migrations claiming the same version', () => {
    const { driver, dir } = freshDb();
    const migrationsDir = path.join(dir, 'migrations');
    writeFile(migrationsDir, '0001_a.sql', 'SELECT 1;');
    writeFile(migrationsDir, '0001_b.sql', 'SELECT 1;');
    try {
      expect(() => migrate(driver, { dir: migrationsDir })).toThrowError(/Duplicate migration/);
    } finally {
      driver.close();
    }
  });
});

describe('meta repository', () => {
  it('creates an install id once and returns it thereafter', () => {
    const { driver } = freshDb();
    try {
      migrate(driver);
      const meta = new MetaRepository(driver);
      const first = meta.ensureInstallId();
      const second = meta.ensureInstallId();

      expect(first).toBe(second);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(meta.get(META_KEYS.createdAt)).toBeDefined();
    } finally {
      driver.close();
    }
  });

  it('upserts values', () => {
    const { driver } = freshDb();
    try {
      migrate(driver);
      const meta = new MetaRepository(driver);
      meta.set('k', 'v1');
      meta.set('k', 'v2');
      expect(meta.get('k')).toBe('v2');
      expect(meta.all().filter((e) => e.key === 'k')).toHaveLength(1);
    } finally {
      driver.close();
    }
  });
});

describe('maintenance', () => {
  it('passes an integrity check on a fresh database', () => {
    const { driver } = freshDb();
    try {
      migrate(driver);
      expect(checkIntegrity(driver)).toEqual([]);
    } finally {
      driver.close();
    }
  });

  it('produces a usable backup while the database is open', () => {
    const { driver, dir } = freshDb();
    try {
      migrate(driver);
      new MetaRepository(driver).set('marker', 'present');

      const backupPath = path.join(dir, 'backup.sqlite');
      driver.backupTo(backupPath);
      expect(fs.existsSync(backupPath)).toBe(true);

      const restored = openDatabase({ file: backupPath });
      try {
        expect(new MetaRepository(restored).get('marker')).toBe('present');
        expect(checkIntegrity(restored)).toEqual([]);
      } finally {
        restored.close();
      }
    } finally {
      driver.close();
    }
  });
});
