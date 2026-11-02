/**
 * Progress breakdowns — "which cities are done?"
 *
 * The `jobs` table is deliberately automation-agnostic: it stores an opaque
 * `params_json` rather than columns for city and category, so a second
 * automation needs no schema change. The cost is that grouping by city means
 * reaching into that JSON, which is why the grouping keys are parameters here
 * rather than hardcoded — a different automation groups by its own fields.
 *
 * `json_extract` cannot use an index, so this is a full scan of the automation's
 * jobs. Measured at 15,725 rows: ~10ms, which is far cheaper than carrying
 * denormalized columns that only one automation would ever populate.
 */
import type { SqliteDriver } from '../driver/types.js';
import { BaseRepository } from './types.js';

export interface ProgressGroup {
  readonly id: string | number | null;
  readonly label: string;
  readonly sublabel: string | null;
  readonly total: number;
  readonly done: number;
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
  readonly skipped: number;
  /** Parked because the group's city or service is paused. Still unfinished. */
  readonly paused: number;
  /** When the most recent job in this group finished, if any have. */
  readonly lastFinishedAt: number | null;
}

export interface ProgressQuery {
  readonly automationId: string;
  /** JSON path for the grouping key, e.g. `$.cityId`. */
  readonly idPath: string;
  /** JSON path for the display label, e.g. `$.city`. */
  readonly labelPath: string;
  /** Optional JSON path for a secondary label, e.g. `$.stateCode`. */
  readonly sublabelPath?: string;
  /** Hide groups where every job is finished. */
  readonly incompleteOnly?: boolean;
  readonly limit?: number;
}

/** Named groupings for the Google Maps automation. */
export const GROUPINGS = {
  city: { idPath: '$.cityId', labelPath: '$.city', sublabelPath: '$.stateCode' },
  category: { idPath: '$.categoryId', labelPath: '$.category' },
  state: { idPath: '$.stateCode', labelPath: '$.stateCode' },
} as const;

export type GroupingName = keyof typeof GROUPINGS;

export class ProgressRepository extends BaseRepository {
  constructor(driver: SqliteDriver) {
    super(driver);
  }

  groups(query: ProgressQuery): ProgressGroup[] {
    const sublabel =
      query.sublabelPath === undefined
        ? 'NULL'
        : `json_extract(params_json, '${query.sublabelPath}')`;

    // A group counts as complete when nothing is left to run: done and skipped
    // both mean "will not run again". Failed jobs keep a group incomplete,
    // because they are exactly what an operator needs to find, and so do
    // paused ones — pausing a city does not finish it.
    const having =
      query.incompleteOnly === true
        ? `HAVING SUM(status IN ('pending', 'leased', 'failed', 'paused')) > 0`
        : '';

    // GROUP BY and ORDER BY repeat the full expressions rather than referring to
    // the SELECT aliases. SQLite resolves those names against real table columns
    // first, and `jobs` has an `id` column — so `GROUP BY id` silently grouped
    // by the job's own primary key, producing one "group" per job.
    const groupKey = `json_extract(params_json, '${query.idPath}')`;
    const labelKey = `json_extract(params_json, '${query.labelPath}')`;

    const rows = this.driver
      .prepare<{
        group_key: string | number | null;
        label: string | null;
        sublabel: string | null;
        total: number;
        done: number;
        pending: number;
        leased: number;
        failed: number;
        skipped: number;
        paused: number;
        lastFinishedAt: number | null;
      }>(
        `SELECT ${groupKey}              AS group_key,
                ${labelKey}              AS label,
                ${sublabel}              AS sublabel,
                COUNT(*)                 AS total,
                SUM(status = 'done')     AS done,
                SUM(status = 'pending')  AS pending,
                SUM(status = 'leased')   AS leased,
                SUM(status = 'failed')   AS failed,
                SUM(status = 'skipped')  AS skipped,
                SUM(status = 'paused')   AS paused,
                MAX(finished_at)         AS lastFinishedAt
           FROM jobs
          WHERE automation_id = ?
          GROUP BY ${groupKey}
          ${having}
          ORDER BY (CAST(SUM(status IN ('done', 'skipped')) AS REAL) / COUNT(*)) DESC,
                   ${labelKey} ASC
          LIMIT ?`,
      )
      .all([query.automationId, query.limit ?? 1000]);

    return rows.map(({ group_key, ...row }) => ({
      ...row,
      id: group_key,
      label: row.label ?? String(group_key ?? 'unknown'),
    }));
  }
}
