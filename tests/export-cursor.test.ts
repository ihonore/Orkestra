/**
 * Export cursor tests.
 *
 * These exist because the first design was wrong in a way nothing caught: the
 * `leads-flat` view emits one row per (business, email), but its cursor was
 * `businesses.id`. Two consequences, both silent, both permanent:
 *
 *  1. The normal pipeline order is `gms run`, then `gms enrich emails`. Every
 *     address found by enrichment therefore carried a business id already behind
 *     the watermark — so it was never exported, and the CLI printed "up to
 *     date". The emails sat in SQLite, unreachable, which is the exact failure
 *     the whole cursor design was meant to prevent.
 *
 *  2. A business whose emails straddled a page boundary lost the remainder: the
 *     next page asked for `id > lastId`, and that business's id was no longer
 *     greater than the mark it had just set.
 *
 * Each test below is one of those, written as the observable behaviour rather
 * than as an assertion about the SQL.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { ExportsRepository } from '../src/db/repositories/exports.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import {
  BUSINESSES,
  LEADS_FLAT,
  countRemaining,
  readPage,
  type ExportCursor,
} from '../src/views/index.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const START: ExportCursor = { lastId: 0, lastSubId: 0 };

function db(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 'cursor.sqlite') });
  migrate(driver);
  return driver;
}

function addBusiness(driver: SqliteDriver, name: string): number {
  const result = driver
    .prepare(
      `INSERT INTO businesses (dedup_hash, name, automation_id, first_seen_at, last_seen_at)
       VALUES (?, ?, 'google-maps', 0, 0)`,
    )
    .run([`hash-${name}`, name]);
  return Number(result.lastInsertRowid);
}

function addEmail(
  driver: SqliteDriver,
  businessId: number,
  address: string,
  options: { junk?: boolean } = {},
): void {
  const [local = '', domain = ''] = address.split('@');
  const email = driver
    .prepare(
      `INSERT INTO emails (address, local_part, email_domain, is_junk, first_seen_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run([address, local, domain, options.junk === true ? 1 : 0]);

  driver
    .prepare(
      `INSERT INTO business_emails
         (business_id, email_id, source_url, method, confidence, first_seen_at)
       VALUES (?, ?, 'https://example.com', 'mailto', 1.0, 0)`,
    )
    .run([businessId, Number(email.lastInsertRowid)]);
}

/** Drain the view the way an exporter does, returning every row it hands over. */
function exportAll(
  driver: SqliteDriver,
  from: ExportCursor,
  pageSize = 1_000,
): { rows: Record<string, unknown>[]; cursor: ExportCursor } {
  const rows: Record<string, unknown>[] = [];
  let cursor = from;

  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = readPage(driver, LEADS_FLAT, cursor, pageSize);
    rows.push(...page.rows);
    cursor = page.next;
    if (page.done) return { rows, cursor };
  }
  throw new Error('export did not terminate');
}

const emailsIn = (rows: Record<string, unknown>[]): string[] =>
  rows.map((r) => r['email']).filter((e): e is string => typeof e === 'string');

describe('emails found after a business was exported', () => {
  it('reaches the export instead of sitting behind the watermark', () => {
    // This is the bug, reproduced exactly: scrape first, enrich second.
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    const two = addBusiness(driver, 'Biz Two');
    addBusiness(driver, 'Biz Three');

    const first = exportAll(driver, START);
    expect(first.rows).toHaveLength(3); // three leads, no emails yet

    addEmail(driver, one, 'owner@one.com');
    addEmail(driver, one, 'sales@one.com');
    addEmail(driver, two, 'info@two.com');

    const second = exportAll(driver, first.cursor);
    expect(emailsIn(second.rows).sort()).toEqual([
      'info@two.com',
      'owner@one.com',
      'sales@one.com',
    ]);
  });

  it('reports them as pending, rather than claiming to be up to date', () => {
    // The CLI decides whether to say "nothing new" from this number. Getting it
    // wrong is how the loss stayed invisible.
    const driver = db();
    const one = addBusiness(driver, 'Biz One');

    const first = exportAll(driver, START);
    expect(countRemaining(driver, LEADS_FLAT, first.cursor)).toBe(0);

    addEmail(driver, one, 'owner@one.com');
    expect(countRemaining(driver, LEADS_FLAT, first.cursor)).toBe(1);
  });

  it('does not re-send the business rows that were already exported', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addBusiness(driver, 'Biz Two');

    const first = exportAll(driver, START);
    addEmail(driver, one, 'owner@one.com');

    const second = exportAll(driver, first.cursor);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.['email']).toBe('owner@one.com');
  });
});

describe('page boundaries', () => {
  it('keeps every row when one business straddles a page', () => {
    // Five addresses on one business, paged two at a time. Under the old cursor
    // the second page asked for `id > thatBusiness`, and rows 3-5 vanished.
    const driver = db();
    const one = addBusiness(driver, 'Big Firm');
    for (let i = 0; i < 5; i += 1) addEmail(driver, one, `person${i}@firm.com`);

    const { rows } = exportAll(driver, START, 2);
    expect(emailsIn(rows).sort()).toEqual([
      'person0@firm.com',
      'person1@firm.com',
      'person2@firm.com',
      'person3@firm.com',
      'person4@firm.com',
    ]);
  });

  it('delivers exactly what it said was pending, at any page size', () => {
    const driver = db();
    for (let b = 0; b < 7; b += 1) {
      const id = addBusiness(driver, `Biz ${b}`);
      for (let e = 0; e < b % 3; e += 1) addEmail(driver, id, `e${b}-${e}@biz${b}.com`);
    }

    const pending = countRemaining(driver, LEADS_FLAT, START);
    for (const pageSize of [1, 2, 3, 100]) {
      expect(exportAll(driver, START, pageSize).rows).toHaveLength(pending);
    }
  });
});

describe('what a second export sees', () => {
  it('exports nothing when nothing has changed', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'owner@one.com');
    addBusiness(driver, 'Biz Two');

    const first = exportAll(driver, START);
    expect(first.rows).toHaveLength(2);

    expect(exportAll(driver, first.cursor).rows).toHaveLength(0);
  });

  it('picks up businesses added after the last export', () => {
    const driver = db();
    addBusiness(driver, 'Biz One');
    const first = exportAll(driver, START);

    const two = addBusiness(driver, 'Biz Two');
    addEmail(driver, two, 'hi@two.com');

    const second = exportAll(driver, first.cursor);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.['email']).toBe('hi@two.com');
  });
});

describe('junk addresses', () => {
  it('leaves no phantom blank row behind a rejected address', () => {
    // Filtering junk in the ON clause rather than the join would keep the link
    // row and blank the email, so a business whose only address was junk would
    // look like a business that simply has none — twice over if it had two.
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'logo@2x.png', { junk: true });
    addEmail(driver, one, 'icon@3x.png', { junk: true });

    const { rows } = exportAll(driver, START);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['email']).toBeNull();
  });

  it('does not count junk towards the pending total', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'good@one.com');
    addEmail(driver, one, 'logo@2x.png', { junk: true });

    expect(countRemaining(driver, LEADS_FLAT, START)).toBe(1);
    expect(emailsIn(exportAll(driver, START).rows)).toEqual(['good@one.com']);
  });
});

describe('the stored watermark', () => {
  it('survives a round trip through the database', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'owner@one.com');
    addBusiness(driver, 'Biz Two');

    const cursors = new ExportsRepository(driver);
    const { cursor } = exportAll(driver, cursors.cursor('csv', '/tmp/x', 'leads-flat'));
    cursors.advance('csv', '/tmp/x', 'leads-flat', cursor, 2);

    expect(cursors.cursor('csv', '/tmp/x', 'leads-flat')).toEqual(cursor);
    expect(cursor.lastSubId).toBeGreaterThan(0);
  });

  it('never rewinds either watermark', () => {
    const driver = db();
    const cursors = new ExportsRepository(driver);
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 500, lastSubId: 900 }, 500);
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 100, lastSubId: 10 }, 0);

    expect(cursors.cursor('csv', '/tmp/x', 'leads-flat')).toEqual({ lastId: 500, lastSubId: 900 });
  });

  it('starts a --full re-export from the beginning of both streams', () => {
    const driver = db();
    const cursors = new ExportsRepository(driver);
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 500, lastSubId: 900 }, 500);
    cursors.reset('csv', '/tmp/x', 'leads-flat');

    expect(cursors.cursor('csv', '/tmp/x', 'leads-flat')).toEqual({ lastId: 0, lastSubId: 0 });
  });
});

describe('single-cursor views are unaffected', () => {
  it('pages businesses by id as before', () => {
    const driver = db();
    for (let i = 0; i < 5; i += 1) addBusiness(driver, `Biz ${i}`);

    const page = readPage(driver, BUSINESSES, START, 3);
    expect(page.rows).toHaveLength(3);
    expect(page.next.lastId).toBe(3);
    expect(page.next.lastSubId).toBe(0);
  });
});
