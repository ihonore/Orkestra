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

/**
 * How far an export has got.
 *
 * Two watermarks, not one. A view whose grain is one row per business needs
 * only `lastId`; `leads-flat` emits one row per (business, email) and needs a
 * second, because `businesses.id` is not unique across its rows and an email
 * discovered later carries an id that is already behind the mark.
 *
 * Defined here rather than beside the views because it is persisted state — it
 * is a row in `export_cursors`, and `src/db` may not import upstream modules.
 */
export interface ExportCursor {
  readonly lastId: number;
  readonly lastSubId: number;
}

export interface Cursor {
  readonly exporter: string;
  readonly target: string;
  readonly entity: string;
  readonly last_id: number;
  /**
   * The second watermark, for views whose grain is finer than one row per
   * business. `leads-flat` emits one row per (business, email), so `last_id`
   * alone cannot say where it has reached — see {@link readLeadPage}.
   */
  readonly last_sub_id: number;
  readonly rows_total: number;
  readonly last_at: Timestamp | null;
}

/** The starting cursor: before everything. */
export const CURSOR_ZERO: ExportCursor = { lastId: 0, lastSubId: 0 };

export class ExportsRepository extends BaseRepository {
  readonly #get: PreparedStatement<Cursor>;
  readonly #advance: PreparedStatement;

  constructor(driver: SqliteDriver) {
    super(driver);

    this.#get = driver.prepare<Cursor>(
      `SELECT exporter, target, entity, last_id, last_sub_id, rows_total, last_at
         FROM export_cursors WHERE exporter = ? AND target = ? AND entity = ?`,
    );

    this.#advance = driver.prepare(
      `INSERT INTO export_cursors
         (exporter, target, entity, last_id, last_sub_id, rows_total, last_at)
       VALUES (:exporter, :target, :entity, :lastId, :lastSubId, :rows, :now)
       ON CONFLICT (exporter, target, entity) DO UPDATE SET
         -- MAX, never a plain assignment: two exporters running concurrently
         -- must not let a slower one rewind the watermark and re-export
         -- everything the faster one already wrote.
         last_id = MAX(last_id, :lastId),
         last_sub_id = MAX(last_sub_id, :lastSubId),
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

  /** Where this export has reached, or the start if it has never run. */
  cursor(exporter: string, target: string, entity: string): ExportCursor {
    const row = this.position(exporter, target, entity);
    return row === null ? CURSOR_ZERO : { lastId: row.last_id, lastSubId: row.last_sub_id };
  }

  advance(
    exporter: string,
    target: string,
    entity: string,
    cursor: ExportCursor,
    rows: number,
    now: Timestamp = Date.now(),
  ): void {
    this.#advance.run({
      exporter,
      target,
      entity,
      lastId: cursor.lastId,
      lastSubId: cursor.lastSubId,
      rows,
      now,
    });
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
        `SELECT exporter, target, entity, last_id, last_sub_id, rows_total, last_at
           FROM export_cursors ORDER BY exporter, entity`,
      )
      .all();
  }
}
