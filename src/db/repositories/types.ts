/**
 * Repository contracts.
 *
 * Repositories are the only place that knows SQL. Everything above them speaks
 * in domain objects, which is what makes the PostgreSQL move a rewrite confined
 * to this directory rather than a rewrite of the application.
 *
 * A caveat worth stating plainly, because it is often oversold: moving SQLite ->
 * PostgreSQL is *not* free. The schema files, the migration set, and the
 * synchronous-to-async driver change all have to be redone. What this boundary
 * buys is that the call sites above it survive.
 */
import type { SqliteDriver } from '../driver/types.js';

/** Milliseconds since the Unix epoch. The single time representation in the DB. */
export type Timestamp = number;

/**
 * A unit of work executed against the database.
 *
 * Deliberately synchronous. The driver is synchronous, and allowing an `await`
 * inside a transaction would let a concurrent worker's writes be captured by it.
 */
export type Work<T> = (driver: SqliteDriver) => T;

export interface Repository {
  readonly driver: SqliteDriver;
}

/** Base class supplying the driver handle and transaction helper. */
export abstract class BaseRepository implements Repository {
  constructor(readonly driver: SqliteDriver) {}

  /** Run `work` in an IMMEDIATE transaction. Use for any multi-statement write. */
  protected inTransaction<T>(work: Work<T>): T {
    return this.driver.transaction(() => work(this.driver), 'immediate');
  }
}
