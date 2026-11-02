/**
 * The jobs that belong to one city or one category.
 *
 * Editing seed data is only half a change: the queue holds a copy of every
 * seed's fields in `params_json` (so a job can run without re-reading seeds),
 * and a pause that leaves a city's 85 searches claimable is not a pause. This
 * repository is the other half — it finds a seed's jobs and keeps them in step.
 *
 * Like {@link ProgressRepository} it reaches into `params_json` with
 * `json_extract`, which cannot use an index. Measured at 15,725 jobs that is
 * ~10ms per statement, paid once per edit rather than once per claim.
 */
import type { SqliteDriver } from '../driver/types.js';
import type { JobSpec } from './jobs.js';
import { BaseRepository, type Timestamp } from './types.js';

export type SeedKind = 'city' | 'category';

/** Where each kind of seed id lives in a Google Maps job's params. */
const ID_PATH: Record<SeedKind, string> = {
  city: '$.cityId',
  category: '$.categoryId',
};

/** And in `business_sightings`, which records what was searched for. */
const SIGHTING_COLUMN: Record<SeedKind, string> = {
  city: 'seed_city_id',
  category: 'seed_category_id',
};

export interface UnstartedJob {
  readonly id: number;
  readonly priority: number;
  readonly cityId: number;
  readonly categoryId: number;
  readonly stateCode: string;
}

export interface SeedJobCounts {
  readonly total: number;
  readonly done: number;
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
  readonly skipped: number;
  readonly paused: number;
  readonly lastFinishedAt: number | null;
}

/**
 * Jobs that have not produced anything yet and are not running, so rewriting or
 * deleting them loses nothing. `failed` is included: a failed search has no
 * results, and a retry should run with the corrected seed, not the stale one.
 */
const UNSTARTED = `('pending', 'paused', 'failed')`;

export class SeedJobsRepository extends BaseRepository {
  constructor(
    driver: SqliteDriver,
    private readonly automationId = 'google-maps',
  ) {
    super(driver);
  }

  /** Whether `plan` has ever been run, i.e. whether there is a queue to keep in step. */
  planned(): boolean {
    return (
      this.driver
        .prepare<{ n: number }>(`SELECT EXISTS (SELECT 1 FROM jobs WHERE automation_id = ?) AS n`)
        .get([this.automationId])?.n === 1
    );
  }

  /** Job counts per seed id, for every seed that has any jobs. */
  counts(kind: SeedKind): Map<number, SeedJobCounts> {
    const key = `json_extract(params_json, '${ID_PATH[kind]}')`;
    const rows = this.driver
      .prepare<SeedJobCounts & { seed_id: number }>(
        `SELECT ${key}                  AS seed_id,
                COUNT(*)                AS total,
                SUM(status = 'done')    AS done,
                SUM(status = 'pending') AS pending,
                SUM(status = 'leased')  AS leased,
                SUM(status = 'failed')  AS failed,
                SUM(status = 'skipped') AS skipped,
                SUM(status = 'paused')  AS paused,
                MAX(finished_at)        AS lastFinishedAt
           FROM jobs
          WHERE automation_id = ?
          GROUP BY ${key}`,
      )
      .all([this.automationId]);
    return new Map(rows.map(({ seed_id, ...counts }) => [seed_id, counts]));
  }

  /** Distinct businesses found per seed id. */
  leads(kind: SeedKind): Map<number, number> {
    const column = SIGHTING_COLUMN[kind];
    const rows = this.driver
      .prepare<{ seed_id: number; n: number }>(
        `SELECT ${column} AS seed_id, COUNT(DISTINCT business_id) AS n
           FROM business_sightings
          WHERE ${column} IS NOT NULL
          GROUP BY ${column}`,
      )
      .all();
    return new Map(rows.map((row) => [row.seed_id, row.n]));
  }

  /** Whether any business was found by searching for this seed. */
  hasLeads(kind: SeedKind, id: number): boolean {
    const column = SIGHTING_COLUMN[kind];
    return (
      this.driver
        .prepare<{ n: number }>(
          `SELECT EXISTS (SELECT 1 FROM business_sightings WHERE ${column} = ?) AS n`,
        )
        .get([id])?.n === 1
    );
  }

  /** How many of this seed's jobs a worker holds right now. */
  leased(kind: SeedKind, id: number): number {
    return (
      this.driver
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM jobs
            WHERE automation_id = ? AND status = 'leased'
              AND json_extract(params_json, '${ID_PATH[kind]}') = ?`,
        )
        .get([this.automationId, id])?.n ?? 0
    );
  }

  /**
   * Make `pending` vs `paused` match the one rule for what may be claimed:
   *
   *   the city is active, the service is active, and — when the queue is
   *   restricted to some states — the city is in one of them.
   *
   * One statement owns the rule, rather than separate pause and resume paths
   * that each re-derive it. That matters because jobs also drift back to
   * `pending` on their own (a worker releasing one at shutdown, a retry), and
   * running this again is all it takes to put them right.
   *
   * Only `pending` and `paused` move. A leased job is mid-search and finishes;
   * a failed one stays failed, so this can never turn an exhausted job into a
   * `pending` row that the claim's attempt guard then skips forever.
   *
   * `scheduled_at` is left alone, so a resumed job keeps its place.
   */
  syncPaused(onlyStates: readonly string[] | null, now: Timestamp = Date.now()): number {
    return this.driver
      .prepare(
        `UPDATE jobs
            SET status = CASE WHEN status = 'pending' THEN 'paused' ELSE 'pending' END,
                updated_at = :now
          WHERE automation_id = :automationId AND status IN ('pending', 'paused')
            AND (status = 'pending') <> (
                  json_extract(params_json, '$.cityId')
                    IN (SELECT id FROM cities WHERE active = 1)
              AND json_extract(params_json, '$.categoryId')
                    IN (SELECT id FROM categories WHERE active = 1)
              AND (:states IS NULL OR json_extract(params_json, '$.stateCode')
                    IN (SELECT value FROM json_each(:states))))`,
      )
      .run({
        now,
        automationId: this.automationId,
        states: onlyStates === null || onlyStates.length === 0 ? null : JSON.stringify(onlyStates),
      }).changes;
  }

  /** Every job that has not run yet, with what ordering it needs to know. */
  unstarted(): UnstartedJob[] {
    return this.driver
      .prepare<UnstartedJob>(
        `SELECT id, priority,
                json_extract(params_json, '$.cityId')     AS cityId,
                json_extract(params_json, '$.categoryId') AS categoryId,
                json_extract(params_json, '$.stateCode')  AS stateCode
           FROM jobs
          WHERE automation_id = ? AND status IN ${UNSTARTED}`,
      )
      .all([this.automationId]);
  }

  /** Finished searches per state, so a well-covered state can wait its turn. */
  finishedByState(): Map<string, number> {
    const rows = this.driver
      .prepare<{ state: string; n: number }>(
        `SELECT json_extract(params_json, '$.stateCode') AS state, COUNT(*) AS n
           FROM jobs
          WHERE automation_id = ? AND status IN ('done', 'skipped')
          GROUP BY json_extract(params_json, '$.stateCode')`,
      )
      .all([this.automationId]);
    return new Map(rows.map((row) => [row.state, row.n]));
  }

  /** Write new priorities, in one transaction. Returns how many changed. */
  setPriorities(priorities: ReadonlyMap<number, number>, now: Timestamp = Date.now()): number {
    if (priorities.size === 0) return 0;
    const statement = this.driver.prepare(
      `UPDATE jobs SET priority = ?, updated_at = ?
        WHERE id = ? AND status IN ${UNSTARTED} AND priority <> ?`,
    );
    return this.inTransaction(() => {
      let changed = 0;
      for (const [id, priority] of priorities) {
        changed += statement.run([priority, now, id, priority]).changes;
      }
      return changed;
    });
  }

  /**
   * The next searches a worker would claim, in claim order. A preview: it
   * ignores the backoff window, which only delays a retry by minutes.
   */
  nextUp(limit: number): { city: string; stateCode: string; category: string }[] {
    return this.driver
      .prepare<{ city: string; stateCode: string; category: string }>(
        `SELECT json_extract(params_json, '$.city')      AS city,
                json_extract(params_json, '$.stateCode') AS stateCode,
                json_extract(params_json, '$.category')  AS category
           FROM jobs
          WHERE automation_id = ? AND status = 'pending' AND attempts < max_attempts
          ORDER BY priority DESC, scheduled_at ASC, id ASC
          LIMIT ?`,
      )
      .all([this.automationId, limit]);
  }

  /**
   * Rewrite the params of jobs that have not run yet, after their seed was
   * edited. Without this a corrected latitude would only reach jobs planned
   * *after* the fix, and the rest would search the old location.
   *
   * Priority is not touched: the queue order is computed across the whole
   * queue (see `src/seeds/queue.ts`), not from one job's own seed.
   *
   * Finished jobs keep their params: they record what was actually searched.
   */
  refresh(specs: readonly JobSpec[], now: Timestamp = Date.now()): number {
    if (specs.length === 0) return 0;
    // Unchanged rows are skipped, so the count reports real corrections and a
    // re-import of the same sheet does not touch 15,725 rows for nothing. The
    // params are compared as text, which works because the planner builds them
    // with a fixed key order.
    const statement = this.driver.prepare(
      `UPDATE jobs SET params_json = :params, updated_at = :now
        WHERE automation_id = :automationId AND task_key = :taskKey
          AND status IN ${UNSTARTED} AND params_json <> :params`,
    );
    return this.inTransaction(() => {
      let changed = 0;
      for (const spec of specs) {
        changed += statement.run({
          params: JSON.stringify(spec.params ?? {}),
          now,
          automationId: spec.automationId,
          taskKey: spec.taskKey,
        }).changes;
      }
      return changed;
    });
  }

  /**
   * Delete every job for this seed that is not running. Callers check
   * {@link hasLeads} first: deleting a job cascades to its sightings, which are
   * the only record of which search found a business.
   */
  removeUnleased(kind: SeedKind, id: number): number {
    return this.driver
      .prepare(
        `DELETE FROM jobs
          WHERE automation_id = ? AND status <> 'leased'
            AND json_extract(params_json, '${ID_PATH[kind]}') = ?`,
      )
      .run([this.automationId, id]).changes;
  }
}
