/**
 * better-sqlite3 implementation of {@link SqliteDriver}.
 *
 * Chosen over node:sqlite for M0 because it is stable rather than release
 * candidate, and over v12 of itself because v13 ships N-API prebuilds *inside*
 * the npm tarball with `gypfile: false` and no install script. That is what
 * makes `npm install` work on a bare Windows VPS with no Visual Studio Build
 * Tools: npm never invokes node-gyp and never fetches a binary at install time.
 */
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { DatabaseError } from '../../core/errors/taxonomy.js';
import { displayPath } from '../../core/util/paths.js';
import type {
  OpenDriverOptions,
  PreparedStatement,
  RunResult,
  SqliteDriver,
  SqlParams,
  TransactionMode,
} from './types.js';

/**
 * better-sqlite3's binding takes parameters as spread arguments, where a single
 * object argument means named parameters. Passing `undefined` through would be
 * read as one positional parameter, so an absent params list must become `[]`.
 */
function toArgs(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? [...(params as unknown[])] : [params];
}

class BetterSqlite3Statement<TRow> implements PreparedStatement<TRow> {
  constructor(private readonly statement: Database.Statement) {}

  get(params?: SqlParams): TRow | undefined {
    return this.statement.get(...toArgs(params)) as TRow | undefined;
  }

  all(params?: SqlParams): TRow[] {
    return this.statement.all(...toArgs(params)) as TRow[];
  }

  run(params?: SqlParams): RunResult {
    const result = this.statement.run(...toArgs(params));
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  iterate(params?: SqlParams): IterableIterator<TRow> {
    return this.statement.iterate(...toArgs(params)) as IterableIterator<TRow>;
  }
}

export class BetterSqlite3Driver implements SqliteDriver {
  readonly kind = 'better-sqlite3' as const;
  readonly file: string;
  private readonly db: BetterSqlite3Database;

  constructor(options: OpenDriverOptions) {
    this.file = options.file;
    try {
      this.db = new Database(options.file, {
        readonly: options.readonly ?? false,
        fileMustExist: false,
      });
    } catch (cause) {
      throw new DatabaseError(`Could not open database at ${displayPath(options.file)}`, {
        code: 'DB_OPEN_FAILED',
        hint: 'Check that the directory exists and is writable.',
        cause,
      });
    }

    // better-sqlite3 defaults this to 5000ms. That default is actively harmful
    // here: the busy handler sleeps the calling thread, stalling every worker
    // and timer in the process. Contention is handled by application-level
    // retry with jitter, so this is only a backstop.
    if (options.busyTimeoutMs !== undefined) {
      this.db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    }
  }

  get open(): boolean {
    return this.db.open;
  }

  prepare<TRow = unknown>(sql: string): PreparedStatement<TRow> {
    return new BetterSqlite3Statement<TRow>(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma<T = unknown>(name: string): T {
    return this.db.pragma(name, { simple: true }) as T;
  }

  setPragma<T = unknown>(name: string, value: string | number | boolean): T {
    const literal = typeof value === 'boolean' ? (value ? 'ON' : 'OFF') : value;
    return this.db.pragma(`${name} = ${literal}`, { simple: true }) as T;
  }

  transaction<T>(fn: () => T, mode: TransactionMode = 'immediate'): T {
    const wrapped = this.db.transaction(fn);
    switch (mode) {
      case 'immediate':
        return wrapped.immediate();
      case 'exclusive':
        return wrapped.exclusive();
      case 'deferred':
        return wrapped.deferred();
    }
  }

  backupTo(destinationFile: string): void {
    // VACUUM INTO produces a compacted, transactionally consistent copy and,
    // unlike a file copy, cannot capture a torn mid-transaction state.
    this.db.exec(`VACUUM INTO ${quoteStringLiteral(destinationFile)}`);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** SQL string literal quoting. VACUUM INTO takes a literal, not a bound parameter. */
function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function openBetterSqlite3(options: OpenDriverOptions): SqliteDriver {
  return new BetterSqlite3Driver(options);
}
