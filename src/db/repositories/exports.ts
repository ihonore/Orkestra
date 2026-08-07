/**
 * Export watermarks.
 *
 * The cursor is advanced only *after* a write is confirmed. That ordering is the
 * whole design: a crash between writing and committing the cursor re-exports a
 * few rows, which is recoverable, whereas advancing first would skip them
 * silently, which is not.
 */
import type { PreparedStatement, SqliteDriver } from '../driver/types.js';
import { BaseRepository, type Timestamp } from './types.js';

export interface Cursor {
  readonly exporter: string;
  readonly target: string;
  readonly entity: string;
  readonly last_id: number;
  readonly rows_total: number;
  readonly last_at: Timestamp | null;
}

export class ExportsRepository extends BaseRepository {
  readonly #get: PreparedStatement<Cursor>;
  readonly #advance: PreparedStatement;

  constructor(driver: SqliteDriver) {
    super(driver);

    this.#get = driver.prepare<Cursor>(
      `SELECT exporter, target, entity, last_id, rows_total, last_at
         FROM export_cursors WHERE exporter = ? AND target = ? AND entity = ?`,
    );

    this.#advance = driver.prepare(
      `INSERT INTO export_cursors (exporter, target, entity, last_id, rows_total, last_at)
       VALUES (:exporter, :target, :entity, :lastId, :rows, :now)
       ON CONFLICT (exporter, target, entity) DO UPDATE SET
         -- MAX, never a plain assignment: two exporters running concurrently
         -- must not let a slower one rewind the watermark and re-export
         -- everything the faster one already wrote.
         last_id = MAX(last_id, :lastId),
         rows_total = rows_total + :rows,
         last_at = :now`,
    );
  }

  position(exporter: string, target: string, entity: string): Cursor | null {
    return this.#get.get([exporter, target, entity]) ?? null;
  }

  lastId(exporter: string, target: string, entity: string): number {
    return this.position(exporter, target, entity)?.last_id ?? 0;
  }

  advance(
    exporter: string,
    target: string,
    entity: string,
    lastId: number,
    rows: number,
    now: Timestamp = Date.now(),
  ): void {
    this.#advance.run({ exporter, target, entity, lastId, rows, now });
  }

  /** Start over. `--full` re-exports everything from the beginning. */
  reset(exporter: string, target: string, entity: string): void {
    this.driver
      .prepare(`DELETE FROM export_cursors WHERE exporter = ? AND target = ? AND entity = ?`)
      .run([exporter, target, entity]);
  }

  all(): Cursor[] {
    return this.driver
      .prepare<Cursor>(
        `SELECT exporter, target, entity, last_id, rows_total, last_at
           FROM export_cursors ORDER BY exporter, entity`,
      )
      .all();
  }
}
