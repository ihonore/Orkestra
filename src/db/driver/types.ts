/**
 * The SQLite driver contract.
 *
 * This adapter exists because swapping better-sqlite3 for node:sqlite is *not*
 * the one-line change it is often described as. The query surface is nearly
 * identical, but everything around it differs: better-sqlite3 exposes
 * `db.pragma()` and a `db.transaction()` wrapper, node:sqlite has neither and
 * needs raw `exec('PRAGMA ...')`. Routing pragmas, transactions and backups
 * through this interface keeps that difference in one file.
 *
 * It also documents two behaviours that are easy to get wrong:
 *
 *  - `get`/`all` must be used for statements with a RETURNING clause. In
 *    better-sqlite3, `run()` steps once and returns only
 *    `{changes, lastInsertRowid}`, silently discarding RETURNING rows. Job
 *    leasing depends on RETURNING, so using `run()` there would lease a job and
 *    lose its identity.
 *
 *  - `transaction()` callbacks are synchronous. A transaction must never span an
 *    `await`: on a shared connection that would absorb other workers' writes
 *    into this transaction.
 */

export type SqlValue = string | number | bigint | Buffer | null;

/** Positional (`?`) or named (`:name`) statement parameters. */
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface PreparedStatement<TRow = unknown> {
  /**
   * Execute and return the first row, or `undefined` when there is none.
   * Use this — not `run` — for any statement with a RETURNING clause.
   */
  get(params?: SqlParams): TRow | undefined;
  all(params?: SqlParams): TRow[];
  /**
   * Execute for effect.
   *
   * Never use with RETURNING: the returned rows are discarded.
   */
  run(params?: SqlParams): RunResult;
  iterate(params?: SqlParams): IterableIterator<TRow>;
}

export type TransactionMode = 'deferred' | 'immediate' | 'exclusive';

export interface SqliteDriver {
  readonly kind: 'better-sqlite3' | 'node-sqlite';
  /** Absolute path, or ':memory:'. */
  readonly file: string;
  readonly open: boolean;

  prepare<TRow = unknown>(sql: string): PreparedStatement<TRow>;
  /** Run one or more statements for effect. Cannot take parameters. */
  exec(sql: string): void;

  /** Read a pragma value. */
  pragma<T = unknown>(name: string): T;
  /** Set a pragma. Returns whatever the pragma reports back. */
  setPragma<T = unknown>(name: string, value: string | number | boolean): T;

  /**
   * Run `fn` inside a transaction, committing on return and rolling back if it
   * throws. `fn` must be synchronous.
   *
   * Use `'immediate'` for anything that will write. A deferred transaction that
   * reads first must promote to a writer, which under WAL fails with
   * SQLITE_BUSY_SNAPSHOT — and the busy handler is *not* invoked for that code,
   * so the busy timeout will not retry it.
   */
  transaction<T>(fn: () => T, mode?: TransactionMode): T;

  /** Consistent on-line copy. Safe while other connections are writing. */
  backupTo(destinationFile: string): void;

  close(): void;
}

export interface OpenDriverOptions {
  readonly file: string;
  readonly readonly?: boolean;
  /**
   * Milliseconds SQLite waits on a locked database before returning SQLITE_BUSY.
   *
   * Keep this small. The busy handler sleeps the calling thread, and because the
   * driver is synchronous that blocks the whole event loop — every worker and
   * every timer — for the full duration.
   */
  readonly busyTimeoutMs?: number;
}
