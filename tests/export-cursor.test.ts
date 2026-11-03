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
  LEADS_BY_BUSINESS,
  LEADS_FLAT,
  LEADS_WITH_EMAIL_VIEW,
  countRemaining,
  readPage,
  startingCursor,
  type ExportCursor,
  type RecordSchema,
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
  options: { junk?: boolean; role?: boolean; free?: boolean } = {},
): void {
  const [local = '', domain = ''] = address.split('@');
  const email = driver
    .prepare(
      `INSERT OR IGNORE INTO emails (address, local_part, email_domain, is_junk, is_role, is_free,
                                     first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run([
      address,
      local,
      domain,
      options.junk === true ? 1 : 0,
      options.role === true ? 1 : 0,
      options.free === true ? 1 : 0,
    ]);
  const emailId =
    email.changes > 0
      ? Number(email.lastInsertRowid)
      : driver.prepare<{ id: number }>(`SELECT id FROM emails WHERE address = ?`).get([address])!
          .id;

  driver
    .prepare(
      `INSERT INTO business_emails
         (business_id, email_id, source_url, method, confidence, first_seen_at)
       VALUES (?, ?, 'https://example.com', 'mailto', 1.0, 0)`,
    )
    .run([businessId, emailId]);
}

/** Give a business a website domain, so "its own domain" means something. */
function setDomain(driver: SqliteDriver, businessId: number, domain: string): void {
  const id = Number(
    driver.prepare(`INSERT INTO domains (domain, created_at) VALUES (?, 0)`).run([domain])
      .lastInsertRowid,
  );
  driver.prepare(`UPDATE businesses SET domain_id = ? WHERE id = ?`).run([id, businessId]);
}

/** Drain the view the way an exporter does, returning every row it hands over. */
function exportAll(
  driver: SqliteDriver,
  from: ExportCursor,
  pageSize = 1_000,
  schema: RecordSchema = LEADS_FLAT,
): { rows: Record<string, unknown>[]; cursor: ExportCursor } {
  const rows: Record<string, unknown>[] = [];
  let cursor = from;

  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = readPage(driver, schema, cursor, pageSize);
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

describe('leads with an email only', () => {
  // The view autopilot sends to the sheet. A business with no email is a blank
  // row in leads-flat and a second row once enrichment finds an address — fine
  // for a phone list, noise in a sheet meant for email outreach.
  it('sends each address once and no businesses without one', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addBusiness(driver, 'Biz Two'); // never gets an email
    addEmail(driver, one, 'owner@one.com');

    const first = exportAll(driver, START, 1_000, LEADS_WITH_EMAIL_VIEW);
    expect(emailsIn(first.rows)).toEqual(['owner@one.com']);
    expect(first.rows).toHaveLength(1);

    addEmail(driver, one, 'sales@one.com');
    expect(countRemaining(driver, LEADS_WITH_EMAIL_VIEW, first.cursor)).toBe(1);
    const second = exportAll(driver, first.cursor, 1_000, LEADS_WITH_EMAIL_VIEW);
    expect(emailsIn(second.rows)).toEqual(['sales@one.com']);
  });

  it('pages without losing or repeating a row', () => {
    const driver = db();
    for (let i = 0; i < 7; i += 1) addEmail(driver, addBusiness(driver, `B${i}`), `a${i}@x.com`);
    const all = exportAll(driver, START, 2, LEADS_WITH_EMAIL_VIEW);
    expect(emailsIn(all.rows)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `a${i}@x.com`));
  });

  it('carries on from a leads-flat export to the same tab, so nothing is sent twice', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'owner@one.com');
    const flat = exportAll(driver, START); // the sheet now has owner@one.com
    addEmail(driver, one, 'sales@one.com');

    const start = startingCursor('leads-with-email', null, flat.cursor);
    expect(emailsIn(exportAll(driver, start, 1_000, LEADS_WITH_EMAIL_VIEW).rows)).toEqual([
      'sales@one.com',
    ]);
  });

  it('and the other way round: leads-flat skips what the email-only export sent', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'owner@one.com');
    const emailOnly = exportAll(driver, START, 1_000, LEADS_WITH_EMAIL_VIEW);
    addBusiness(driver, 'Biz Two');

    const start = startingCursor('leads-flat', null, emailOnly.cursor);
    const rows = exportAll(driver, start).rows;
    // Biz One's address is already in the sheet, and a business with an email
    // never gets a blank row; Biz Two has none yet, so it gets exactly one.
    expect(emailsIn(rows)).toEqual([]);
    expect(rows.map((r) => r['name'])).toEqual(['Biz Two']);
  });
});

describe('one row per business', () => {
  // The layout the team's sheet uses: a business with five addresses used to
  // fill five rows.
  const send = (driver: SqliteDriver, from = START, pageSize = 1_000) =>
    exportAll(driver, from, pageSize, LEADS_BY_BUSINESS);

  it('lists each business once, with its best address first and the rest beside it', () => {
    const driver = db();
    const synergy = addBusiness(driver, 'Synergy Business Brokers');
    setDomain(driver, synergy, 'synergybb.com');
    addEmail(driver, synergy, 'info@synergybb.com', { role: true });
    addEmail(driver, synergy, 'bo@gmail.com', { free: true });
    addEmail(driver, synergy, 'ashish@synergybb.com');
    addEmail(driver, synergy, 'partner@otherfirm.com');

    const rows = send(driver).rows;
    expect(rows).toHaveLength(1);
    // A named person at the business's own domain, then its role address,
    // then other non-free mail, then free mail.
    expect(rows[0]).toMatchObject({
      name: 'Synergy Business Brokers',
      email: 'ashish@synergybb.com',
      email_type: 'personal',
      other_emails: 'info@synergybb.com, partner@otherfirm.com, bo@gmail.com',
      email_count: 4,
    });
  });

  it('leaves out businesses with no email', () => {
    const driver = db();
    addBusiness(driver, 'No Email Yet');
    expect(send(driver).rows).toEqual([]);
  });

  it('sends a business once, even after it gains another address', () => {
    const driver = db();
    const one = addBusiness(driver, 'Biz One');
    addEmail(driver, one, 'owner@one.com');
    const first = send(driver);
    expect(first.rows).toHaveLength(1);

    addEmail(driver, one, 'sales@one.com'); // a recrawl months later
    const two = addBusiness(driver, 'Biz Two');
    addEmail(driver, two, 'hi@two.com');
    expect(send(driver, first.cursor).rows.map((r) => r['name'])).toEqual(['Biz Two']);
  });

  it('pages without losing or repeating a business', () => {
    const driver = db();
    for (let i = 0; i < 9; i += 1) {
      const id = addBusiness(driver, `B${i}`);
      addEmail(driver, id, `a${i}@x${i}.com`);
      addEmail(driver, id, `b${i}@x${i}.com`);
    }
    const names = send(driver, START, 2).rows.map((r) => r['name']);
    expect(names).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `B${i}`));
    expect(countRemaining(driver, LEADS_BY_BUSINESS, START)).toBe(9);
  });

  it("leaves out an address that belongs to the site's builder or a vendor", () => {
    const driver = db();
    const id = addBusiness(driver, 'United Auto Sales');
    addEmail(driver, id, 'sales@akunitedauto.com');
    addEmail(driver, id, 'support@overfuel.com');
    driver
      .prepare(
        `UPDATE business_emails SET off_site = 1
          WHERE email_id = (SELECT id FROM emails WHERE address = 'support@overfuel.com')`,
      )
      .run();
    expect(send(driver).rows[0]).toMatchObject({
      email: 'sales@akunitedauto.com',
      other_emails: null,
    });
    expect(emailsIn(exportAll(driver, START).rows)).toEqual(['sales@akunitedauto.com']);
  });

  it('ranks privacy@-type addresses last, even below free mail', () => {
    const driver = db();
    const id = addBusiness(driver, 'Classic Collision');
    setDomain(driver, id, 'classiccollision.com');
    addEmail(driver, id, 'privacy@classiccollision.com', { role: true });
    addEmail(driver, id, 'owner.cc@gmail.com', { free: true });
    expect(send(driver).rows[0]).toMatchObject({
      email: 'owner.cc@gmail.com',
      other_emails: 'privacy@classiccollision.com',
    });
  });

  it('never offers a junk address, as best or as another', () => {
    const driver = db();
    const id = addBusiness(driver, 'Acme');
    addEmail(driver, id, 'info@youwebsite.com', { junk: true });
    addEmail(driver, id, 'owner@acme.com');
    expect(send(driver).rows[0]).toMatchObject({ email: 'owner@acme.com', other_emails: null });
  });
});
