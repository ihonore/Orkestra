/**
 * `gms export sheets` end to end: the real command and the real Sheets client,
 * against a mock that refuses what real Google refuses.
 *
 * The parts had tests and the whole did not, and four faults lived in the gaps
 * between them. The worst shipped: a rebuild asked Google to delete every row
 * under a frozen header, which Google refuses with a 400, so it failed on every
 * attempt — and since a pending rebuild goes ahead of normal sends, the team's
 * sheet silently stopped updating for a day.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import type { ResolvedConfig } from '../src/config/schema.js';
import { runExportSheets } from '../src/cli/commands/export.js';
import { openDatabase } from '../src/db/client.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { migrate } from '../src/db/migrate.js';
import { ExportsRepository } from '../src/db/repositories/exports.js';
import { pendingSheetRebuild, requestSheetRebuild } from '../src/seeds/rescrape.js';
import { startMockSheets, type MockSheets } from './fixtures/mock-sheets.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

const TAB = 'Leads by business';
const ENTITY = 'leads-by-business';
const SHEET_ID = 'sheet-under-test';
const HEADER = [{ userEnteredValue: { stringValue: 'business_id' } }];

const open: (MockSheets | SqliteDriver)[] = [];

afterEach(async () => {
  for (const item of open.splice(0)) {
    const closed = item.close();
    if (closed !== undefined) await closed;
  }
  cleanupTempDirs();
});

interface Rig {
  readonly config: ResolvedConfig;
  readonly driver: SqliteDriver;
  readonly mock: MockSheets;
  /** A business with one email. */
  addLead(name: string): void;
  send(extra?: { rebuild?: boolean }): Promise<void>;
  /** The email column of the tab, in order, without the header. */
  emailsInTab(): unknown[];
  position(): number;
}

async function rig(
  options: {
    maxRows?: number;
    tabs?: Parameters<typeof startMockSheets>[0];
  } = {},
): Promise<Rig> {
  const root = tempDir();
  writeFile(
    root,
    'gms.config.yaml',
    `exporters:\n  sheets:\n    spreadsheetId: ${SHEET_ID}\n    maxRows: ${options.maxRows ?? 50_000}\n`,
  );
  const config = loadConfig({ cwd: root, env: {} });
  // The same database the command opens for itself.
  const db = openDatabase({ file: config.paths.databaseFile });
  migrate(db);
  const mock = await startMockSheets(
    options.tabs ?? {
      existingTabs: [{ title: TAB, sheetId: 7, rows: 100, values: [HEADER] }],
    },
  );
  open.push(mock, db);

  let n = 0;
  return {
    config,
    driver: db,
    mock,
    addLead: (name) => {
      n += 1;
      const business = Number(
        db
          .prepare(
            `INSERT INTO businesses (dedup_hash, name, automation_id, first_seen_at, last_seen_at)
             VALUES (?, ?, 'google-maps', 0, 0)`,
          )
          .run([`h${n}-${name}`, name]).lastInsertRowid,
      );
      const email = Number(
        db
          .prepare(
            `INSERT INTO emails (address, local_part, email_domain, first_seen_at)
             VALUES (?, ?, 'x.com', 0)`,
          )
          .run([`${name}@x.com`, name]).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO business_emails (business_id, email_id, source_url, method, confidence, first_seen_at)
         VALUES (?, ?, 'https://x', 'mailto', 1, 0)`,
      ).run([business, email]);
    },
    send: (extra = {}) =>
      runExportSheets({
        config,
        entity: ENTITY,
        json: true,
        client: { rootUrl: mock.url, authOverride: 'test-key' },
        ...extra,
      }),
    emailsInTab: () =>
      mock
        .rows(TAB)
        .slice(1)
        .map(
          (row) =>
            (row[4] as { userEnteredValue?: { stringValue?: string } }).userEnteredValue
              ?.stringValue,
        ),
    position: () =>
      new ExportsRepository(db).position('sheets', SHEET_ID, ENTITY)?.last_sub_id ?? 0,
  };
}

/** A tab already holding rows from an earlier send, with stale contents. */
const staleTab = (rows = 500) => ({
  existingTabs: [
    {
      title: TAB,
      sheetId: 7,
      rows,
      values: [HEADER, ...Array.from({ length: rows - 1 }, () => [{ stale: true }])],
    },
  ],
});

describe('rebuilding the tab', () => {
  it('replaces what the tab held with the current rows, under the header', async () => {
    const r = await rig({ tabs: staleTab() });
    r.addLead('one');
    r.addLead('two');
    requestSheetRebuild(r.driver, ENTITY);

    await r.send({ rebuild: true });

    expect(r.mock.rows(TAB)[0]).toEqual(HEADER);
    expect(r.emailsInTab()).toEqual(['one@x.com', 'two@x.com']);
    expect(pendingSheetRebuild(r.driver)).toBeNull();
  });

  it('never asks Google for what Google refuses', async () => {
    // Any deleteDimension covering all rows under the header gets a real 400.
    const r = await rig({ tabs: staleTab() });
    r.addLead('one');
    await expect(r.send({ rebuild: true })).resolves.toBeUndefined();
  });

  it('runs first even when an ordinary send gets there before autopilot does', async () => {
    // A pending rebuild has reset nothing yet; a plain send must not append
    // every row beneath the stale ones.
    const r = await rig({ tabs: staleTab() });
    r.addLead('one');
    requestSheetRebuild(r.driver, ENTITY);

    await r.send();

    expect(r.emailsInTab()).toEqual(['one@x.com']);
    expect(pendingSheetRebuild(r.driver)).toBeNull();
  });

  it('keeps its place and its request when the clear itself fails', async () => {
    const r = await rig({ tabs: staleTab() });
    r.addLead('one');
    await r.send(); // an ordinary send: the tab now has rows, the position moved
    const before = r.position();
    requestSheetRebuild(r.driver, ENTITY);
    r.mock.failNext(1, 403);

    await expect(r.send({ rebuild: true })).rejects.toThrow();

    expect(r.position()).toBe(before);
    expect(pendingSheetRebuild(r.driver)).toBe(ENTITY);
  });

  it('after clearing, a failed send resumes rather than wiping the tab again', async () => {
    const r = await rig({ tabs: staleTab() });
    r.addLead('one');
    requestSheetRebuild(r.driver, ENTITY);
    r.mock.failAppends(1, 403);

    await expect(r.send({ rebuild: true })).rejects.toThrow();
    // The tab is clear and the rebuild is spent: nothing can clear it twice.
    expect(r.mock.rows(TAB)).toEqual([HEADER]);
    expect(pendingSheetRebuild(r.driver)).toBeNull();

    await r.send();
    expect(r.emailsInTab()).toEqual(['one@x.com']);
  });

  it('refuses before touching anything if the rows would not fit', async () => {
    // Another tab has used up the spreadsheet's 10M cells.
    const r = await rig({
      tabs: {
        existingTabs: [
          { title: 'Other', sheetId: 1, rows: 500_000, cols: 20 },
          { title: TAB, sheetId: 7, rows: 2, values: [HEADER, [{ stale: true }]] },
        ],
      },
    });
    r.addLead('one');
    r.addLead('two');
    requestSheetRebuild(r.driver, ENTITY);

    await expect(r.send({ rebuild: true })).rejects.toThrow(/cells/);

    expect(r.mock.rows(TAB)).toHaveLength(2);
    expect(pendingSheetRebuild(r.driver)).toBe(ENTITY);
  });
});

describe('a backlog larger than one run', () => {
  it('sends what fits and carries on next run, instead of refusing forever', async () => {
    // The refusal could never clear: the backlog only grows. After a rebuild it
    // came after the wipe, leaving an empty tab.
    const r = await rig({ maxRows: 2 });
    for (const name of ['a', 'b', 'c', 'd', 'e']) r.addLead(name);

    await r.send();
    expect(r.emailsInTab()).toEqual(['a@x.com', 'b@x.com']);

    await r.send();
    await r.send();
    expect(r.emailsInTab()).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']);
  });

  it('rebuilds a tab larger than one run, without clearing it again', async () => {
    const r = await rig({ maxRows: 2, tabs: staleTab() });
    for (const name of ['a', 'b', 'c']) r.addLead(name);
    requestSheetRebuild(r.driver, ENTITY);

    await r.send({ rebuild: true });
    await r.send();

    expect(r.emailsInTab()).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });
});

describe('sending while the email crawl keeps working', () => {
  it('counts a lead found mid-send as a success, not a failure', async () => {
    // Autopilot runs the crawl alongside every send. With an exact count, any
    // address found during a send failed it — and a rebuild would start over.
    const r = await rig();
    r.addLead('first');
    let added = false;
    r.mock.onAppend(() => {
      if (!added) {
        added = true;
        r.addLead('arrived-during-send');
      }
    });

    await expect(r.send()).resolves.toBeUndefined();
    expect(r.emailsInTab()).toEqual(['first@x.com', 'arrived-during-send@x.com']);
  });

  it('counts a lead re-judged away mid-send as a success too', async () => {
    // Re-checking stored emails at the crawl's start can remove a row after the
    // send counted it, which is the rules working, not rows going missing. One
    // past the first page, so it goes after the count and before it is read.
    const r = await rig();
    for (let i = 0; i < 1_001; i += 1) r.addLead(`lead${i}`);
    r.mock.onAppend(() => {
      r.driver
        .prepare(
          `UPDATE business_emails SET off_site = 1
            WHERE email_id = (SELECT id FROM emails WHERE address = 'lead1000@x.com')`,
        )
        .run();
    });

    await expect(r.send()).resolves.toBeUndefined();
    expect(r.emailsInTab()).toHaveLength(1_000);
  });
});
