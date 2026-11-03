/**
 * The re-scrape after an extraction fix, and the sheet hold that goes with it.
 *
 * The VPS runs unattended, so updating must be the whole action: migrate
 * queues the re-scrape once, and the sheet waits until it has run.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import {
  clearSheetRebuild,
  pendingSheetRebuild,
  requestRebuildAfterOwnershipFix,
  requestSheetRebuild,
  requeueAfterExtractionFix,
  requeueFinished,
  rescrapeProgress,
} from '../src/seeds/rescrape.js';
import { addCategory, addCity } from '../src/seeds/manage.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

function db(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 'r.sqlite') });
  migrate(driver);
  return driver;
}

/**
 * Jobs in the given statuses, for an active city and service — a job whose
 * seeds are paused or missing is parked by the queue, and parked jobs
 * deliberately never hold the sheet. Returns their ids in order.
 */
function jobs(driver: SqliteDriver, ...statuses: string[]): number[] {
  const city = addCity(driver, {
    city: `C${Math.random()}`,
    stateCode: 'GA',
    zip: String(10000 + Math.floor(Math.random() * 89999)),
    coordinates: '33, -84',
  }).id;
  const category = addCategory(driver, { name: `S${Math.random()}` }).id;
  const params = JSON.stringify({ cityId: city, categoryId: category, stateCode: 'GA' });
  return statuses.map((status) =>
    Number(
      driver
        .prepare(
          `INSERT INTO jobs (automation_id, task_key, params_json, status, created_at, updated_at,
                             finished_at)
           VALUES ('google-maps', ?, ?, ?, 0, 0, ?)`,
        )
        .run([`k${Math.random()}`, params, status, status === 'done' ? 1 : null]).lastInsertRowid,
    ),
  );
}

const setStatus = (driver: SqliteDriver, ids: number[], status: string) =>
  driver
    .prepare(`UPDATE jobs SET status = ? WHERE id IN (SELECT value FROM json_each(?))`)
    .run([status, JSON.stringify(ids)]);

describe('re-scraping finished searches', () => {
  it('queues every finished search and holds the sheet until they have run', () => {
    const driver = db();
    const [a, b] = jobs(driver, 'done', 'done', 'pending');
    expect(requeueFinished(driver)).toBe(2);
    expect(rescrapeProgress(driver)).toEqual({ total: 2, remaining: 2 });

    setStatus(driver, [a!], 'done');
    expect(rescrapeProgress(driver)).toEqual({ total: 2, remaining: 1 });
    setStatus(driver, [b!], 'done');
    expect(rescrapeProgress(driver)).toBeNull();
  });

  it('does not let a search that failed for good, or a paused one, hold the sheet forever', () => {
    const driver = db();
    const [a, b] = jobs(driver, 'done', 'done');
    requeueFinished(driver);
    setStatus(driver, [a!], 'failed');
    setStatus(driver, [b!], 'paused');
    expect(rescrapeProgress(driver)).toBeNull();
  });

  it('keeps holding when pressed again before the first batch has run', () => {
    const driver = db();
    const [a] = jobs(driver, 'done');
    requeueFinished(driver);
    const [b] = jobs(driver, 'done');
    requeueFinished(driver);
    setStatus(driver, [b!], 'done');
    expect(rescrapeProgress(driver)).toEqual({ total: 2, remaining: 1 });
    setStatus(driver, [a!], 'done');
    expect(rescrapeProgress(driver)).toBeNull();
  });

  it('runs the re-scrape before everything else, so the hold lasts hours, not days', () => {
    // Spread across states, held searches would sit among 15,000 others and
    // the last of them might not run for days, keeping the sheet waiting.
    const driver = db();
    jobs(driver, 'pending', 'pending', 'pending');
    const finished = jobs(driver, 'done', 'done');
    requeueFinished(driver);

    const next = driver
      .prepare<{ id: number }>(
        `SELECT id FROM jobs WHERE status = 'pending'
          ORDER BY priority DESC, scheduled_at ASC, id ASC LIMIT 2`,
      )
      .all()
      .map((row) => row.id);
    expect(next.sort()).toEqual([...finished].sort());
  });

  it('holds nothing when there was nothing to re-read', () => {
    const driver = db();
    expect(requeueFinished(driver)).toBe(0);
    expect(rescrapeProgress(driver)).toBeNull();
  });
});

describe('the re-scrape after the extraction fix', () => {
  it('runs once per database, on migrate', () => {
    const driver = db();
    jobs(driver, 'done', 'done', 'pending');
    expect(requeueAfterExtractionFix(driver)).toBe(2);

    // Later finished searches were scraped with the fixed code: never again.
    driver.prepare(`UPDATE jobs SET status = 'done'`).run();
    expect(requeueAfterExtractionFix(driver)).toBe(0);
  });
});

describe('rebuilding the sheet tab after a correction', () => {
  const sent = (driver: SqliteDriver, entity: string) =>
    driver
      .prepare(
        `INSERT INTO export_cursors (exporter, target, entity, last_id, last_sub_id, rows_total, last_at)
         VALUES ('sheets', 'sheet-id', ?, 0, 10, 10, 0)`,
      )
      .run([entity]);

  it('is requested once, and only where the tab has been sent to', () => {
    const driver = db();
    expect(requestRebuildAfterOwnershipFix(driver)).toBe(false);
    expect(pendingSheetRebuild(driver)).toBeNull();

    const other = db();
    sent(other, 'leads-by-business');
    expect(requestRebuildAfterOwnershipFix(other)).toBe(true);
    expect(pendingSheetRebuild(other)).toBe('leads-by-business');
    expect(requestRebuildAfterOwnershipFix(other)).toBe(false);
  });

  it('is cleared only by the rebuild it was for', () => {
    const driver = db();
    requestSheetRebuild(driver, 'leads-by-business');
    clearSheetRebuild(driver, 'leads-with-email');
    expect(pendingSheetRebuild(driver)).toBe('leads-by-business');
    clearSheetRebuild(driver, 'leads-by-business');
    expect(pendingSheetRebuild(driver)).toBeNull();
  });
});
