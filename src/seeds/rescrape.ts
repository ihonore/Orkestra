/**
 * Re-reading finished searches, and holding the sheet back until it is done.
 *
 * When extraction improves, the businesses already saved were read the old
 * way. Re-running their searches corrects them in place — businesses are
 * matched by their Maps id and updated, never duplicated — but until that
 * finishes, the old data is still what an export would send. So a re-scrape
 * records which searches it queued, and autopilot sends nothing to the sheet
 * while any of them is still waiting to run.
 *
 * The VPS runs unattended, so the re-scrape after the extraction fix is queued
 * by `gms db migrate` itself, once per database: updating is the whole action.
 * Those searches also run before everything else (see `queue.ts`), so the hold
 * lasts about as long as the searches themselves take — not until the sweep
 * happens to reach them, which in a 15,000-search queue could be days.
 */
import type { SqliteDriver } from '../db/driver/types.js';
import { JobsRepository } from '../db/repositories/jobs.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { readHold, writeHold } from './hold.js';
import { syncQueue } from './queue.js';

const AUTOMATION_ID = 'google-maps';
/**
 * Set once the re-scrape for the extraction fix (names and websites taken from
 * other places' data) has been queued on this database. Bump the suffix for a
 * future fix that needs the same treatment.
 */
const EXTRACTION_FIX_KEY = 'rescrape_queued_extraction_v2';

/**
 * Put every finished search back in the queue and hold the sheet until they
 * have all run again. Returns how many were queued.
 */
export function requeueFinished(driver: SqliteDriver, now = Date.now()): number {
  return driver.transaction(() => {
    const ids = driver
      .prepare<{ id: number }>(
        `SELECT id FROM jobs WHERE automation_id = ? AND status = 'done' ORDER BY id`,
      )
      .all([AUTOMATION_ID])
      .map((row) => row.id);
    if (ids.length === 0) return 0;

    new JobsRepository(driver).retry({ ids });
    // Joined with any hold still in force, so pressing the button twice cannot
    // release the sheet before the first batch has run.
    const previous = readHold(driver);
    const merged = [...new Set([...(previous?.ids ?? []), ...ids])];
    writeHold(driver, { since: now, ids: merged });
    syncQueue(driver);
    return ids.length;
  }, 'immediate');
}

/**
 * The one-time re-scrape after the extraction fix, run by `gms db migrate`.
 * Returns how many searches it queued; 0 on a database that has no finished
 * searches, or that has already been through it.
 */
export function requeueAfterExtractionFix(driver: SqliteDriver): number {
  const meta = new MetaRepository(driver);
  if (meta.get(EXTRACTION_FIX_KEY) !== undefined) return 0;
  const queued = requeueFinished(driver);
  meta.set(EXTRACTION_FIX_KEY, String(Date.now()));
  return queued;
}

export interface RescrapeProgress {
  readonly total: number;
  /** Searches of the re-scrape still queued or running. */
  readonly remaining: number;
}

/**
 * How far a re-scrape has got, or null when none is holding the sheet.
 *
 * Only queued and running searches count as remaining. A search that failed
 * for good has finished as far as the hold is concerned, and one paused with
 * its city or service will not run until someone resumes it — neither may keep
 * the sheet waiting forever.
 */
export function rescrapeProgress(driver: SqliteDriver): RescrapeProgress | null {
  const hold = readHold(driver);
  if (hold === null || hold.ids.length === 0) return null;
  const remaining =
    driver
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE id IN (SELECT value FROM json_each(?))
            AND status IN ('pending', 'leased')`,
      )
      .get([JSON.stringify(hold.ids)])?.n ?? 0;
  return remaining === 0 ? null : { total: hold.ids.length, remaining };
}

const REBUILD_KEY = 'sheets_rebuild_pending';
/**
 * Set once the rebuild for the email-ownership fix has been requested.
 * Bump the suffix for a future fix that changes rows already sent.
 */
const OWNERSHIP_FIX_KEY = 'sheets_rebuild_requested_ownership_v1';

/**
 * Ask for the sheet tab of `entity` to be cleared and sent again from scratch.
 *
 * For corrections to rows already sent: the sheet is append-only, so a rule
 * that now drops a vendor's address, or ranks privacy@ last, would otherwise
 * only reach rows sent from now on. Autopilot carries it out at its next
 * chance; `gms export sheets --rebuild` does it directly.
 */
export function requestSheetRebuild(driver: SqliteDriver, entity: string): void {
  new MetaRepository(driver).set(REBUILD_KEY, entity);
}

/** The entity whose tab is waiting to be rebuilt, if any. */
export function pendingSheetRebuild(driver: SqliteDriver): string | null {
  return new MetaRepository(driver).get(REBUILD_KEY) ?? null;
}

/** Mark a rebuild done. Only clears it if it was for this entity. */
export function clearSheetRebuild(driver: SqliteDriver, entity: string): void {
  if (pendingSheetRebuild(driver) !== entity) return;
  driver.prepare(`DELETE FROM meta WHERE key = ?`).run([REBUILD_KEY]);
}

/**
 * The one-time rebuild after the email-ownership fix, requested by
 * `gms db migrate`: rows already in "Leads by business" carry builders' and
 * vendors' addresses, and privacy@ as a best address. Only requested where
 * that tab has actually been sent to. Returns whether it was requested.
 */
export function requestRebuildAfterOwnershipFix(driver: SqliteDriver): boolean {
  const meta = new MetaRepository(driver);
  if (meta.get(OWNERSHIP_FIX_KEY) !== undefined) return false;
  meta.set(OWNERSHIP_FIX_KEY, String(Date.now()));
  const sent =
    driver
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM export_cursors
          WHERE exporter = 'sheets' AND entity = 'leads-by-business' AND rows_total > 0`,
      )
      .get()?.n ?? 0;
  if (sent === 0) return false;
  requestSheetRebuild(driver, 'leads-by-business');
  return true;
}
