/**
 * Sheets exporter tests.
 *
 * These run the *real* Google client against a local mock, so what is asserted
 * is the actual wire format — the thing that determines whether a zip survives
 * or silently becomes a number in a spreadsheet the whole team relies on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_CELLS_PER_SPREADSHEET,
  SheetsExporter,
  chunkBySize,
  estimateMinutes,
  isRetryable,
  toCell,
  toRowData,
  withRetry,
} from '../src/exporters/sheets.js';
import { LEADS_FLAT } from '../src/views/index.js';
import type { FieldDef } from '../src/views/index.js';
import { startMockSheets, type MockSheets } from './fixtures/mock-sheets.js';

const servers: MockSheets[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A tab this tool has already written to: it has its header. */
const WRITTEN = [[{ userEnteredValue: { stringValue: 'name' } }]];

async function exporter(
  options: {
    tabs?: { title: string; sheetId: number; rows?: number; cols?: number; values?: unknown[][] }[];
  } = {},
): Promise<{ mock: MockSheets; sheets: SheetsExporter }> {
  const mock = await startMockSheets({
    existingTabs: (options.tabs ?? [{ title: 'Leads', sheetId: 7 }]).map((tab) => ({
      values: WRITTEN,
      ...tab,
    })),
  });
  servers.push(mock);
  return {
    mock,
    sheets: new SheetsExporter({
      spreadsheetId: 'test-sheet',
      sheetName: 'Leads',
      rootUrl: mock.url,
      authOverride: 'test-key',
    }),
  };
}

const digits: FieldDef = { name: 'zip', kind: 'digits' };
const text: FieldDef = { name: 'name', kind: 'text' };
const number: FieldDef = { name: 'rating', kind: 'number' };

describe('cell typing — the leading-zero guarantee', () => {
  it('sends a zip as an explicit string', () => {
    // `valueInputOption: RAW` is the usual advice and it does not work: the
    // coercion happens client-side before the API sees anything. An explicit
    // stringValue is a typed instruction Sheets cannot reinterpret.
    expect(toCell('02108', digits)).toEqual({ userEnteredValue: { stringValue: '02108' } });
  });

  it('sends a 20-digit CID as a string, losing no precision', () => {
    const cid = '13019781180686529338';
    expect(toCell(cid, { name: 'cid', kind: 'digits' })).toEqual({
      userEnteredValue: { stringValue: cid },
    });
  });

  it('sends a real number as a number, so the column stays sortable', () => {
    expect(toCell(4.9, number)).toEqual({ userEnteredValue: { numberValue: 4.9 } });
  });

  it('leaves a null cell empty rather than writing "null"', () => {
    expect(toCell(null, text)).toEqual({});
    expect(toCell(undefined, text)).toEqual({});
  });

  it('escapes text that Sheets would treat as a formula', () => {
    // A business name starting with '+' or '=' would otherwise render as a
    // broken formula, which reads as corrupted data to whoever opens the sheet.
    expect(toCell('=SUM(A1)', text)).toEqual({ userEnteredValue: { stringValue: "'=SUM(A1)" } });
    expect(toCell('+1 Plumbing', text)).toEqual({
      userEnteredValue: { stringValue: "'+1 Plumbing" },
    });
    expect(toCell('Acme Ltd', text)).toEqual({ userEnteredValue: { stringValue: 'Acme Ltd' } });
  });

  it('writes timestamps as ISO text, unambiguous in any locale', () => {
    expect(toCell(1_700_000_000_000, { name: 'seen', kind: 'timestamp' })).toEqual({
      userEnteredValue: { stringValue: '2023-11-14T22:13:20.000Z' },
    });
  });

  it('orders cells by the schema, not by object key order', () => {
    const row = toRowData({ name: 'Acme', business_id: 5 }, LEADS_FLAT);
    expect(row.values).toHaveLength(LEADS_FLAT.fields.length);
    expect(row.values?.[0]).toEqual({ userEnteredValue: { numberValue: 5 } });
  });
});

describe('what actually reaches the API', () => {
  it('sends typed cells through the real client', async () => {
    const { mock, sheets } = await exporter();
    await sheets.append(
      [{ business_id: 1, name: 'Acme', zip: '02108', cid: '13019781180686529338', rating: 4.9 }],
      LEADS_FLAT,
    );

    const cell = (name: string): unknown =>
      (mock.cells()[0] as unknown[])[LEADS_FLAT.fields.findIndex((f) => f.name === name)];

    expect(cell('zip')).toEqual({ userEnteredValue: { stringValue: '02108' } });
    expect(cell('cid')).toEqual({ userEnteredValue: { stringValue: '13019781180686529338' } });
    expect(cell('rating')).toEqual({ userEnteredValue: { numberValue: 4.9 } });
  });

  it('uses appendCells, not values.append', async () => {
    // values.append takes untyped values and lets Sheets guess, which is how
    // leading zeros are lost.
    const { mock, sheets } = await exporter();
    await sheets.append([{ name: 'Acme' }], LEADS_FLAT);

    const body = mock.requests.find((r) => r.method === 'POST')?.body as {
      requests?: Record<string, unknown>[];
    };
    expect(body.requests?.[0]).toHaveProperty('appendCells');
  });

  it('sends many rows as ONE request', async () => {
    // The quota is 60 writes per minute for the whole service account, and one
    // batchUpdate costs one write however many rows it carries. 500 separate
    // appends would burn eight minutes of budget.
    const { mock, sheets } = await exporter();
    const rows = Array.from({ length: 500 }, (_, i) => ({ business_id: i, name: `Acme ${i}` }));

    const result = await sheets.append(rows, LEADS_FLAT);

    expect(result.appended).toBe(500);
    expect(result.requests).toBe(1);
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(mock.cells()).toHaveLength(500);
  });

  it('preserves row order across chunk boundaries', async () => {
    const { mock, sheets } = await exporter();
    const rows = Array.from({ length: 300 }, (_, i) => ({
      business_id: i,
      name: `Business ${i}`.padEnd(300, 'x'), // force several chunks
    }));

    await sheets.append(rows, LEADS_FLAT);

    const idIndex = LEADS_FLAT.fields.findIndex((f) => f.name === 'business_id');
    const ids = mock
      .cells()
      .map(
        (row) =>
          (row as Record<string, { numberValue?: number }>[])[idIndex]?.userEnteredValue
            ?.numberValue,
      );
    expect(ids).toEqual(rows.map((r) => r.business_id));
  });

  it('creates the tab when it is missing, with a bold frozen header', async () => {
    const { mock, sheets } = await exporter({ tabs: [] });
    await sheets.append([{ name: 'Acme' }], LEADS_FLAT);

    const bodies = mock.requests
      .filter((r) => r.method === 'POST')
      .map((r) => r.body as { requests?: Record<string, unknown>[] });

    const addSheet = bodies.flatMap((b) => b.requests ?? []).find((r) => 'addSheet' in r);
    expect(addSheet).toBeDefined();

    // The first appended row must be the header.
    const header = mock.cells()[0] as { userEnteredValue?: { stringValue?: string } }[];
    expect(header[0]?.userEnteredValue?.stringValue).toBe('business_id');
  });
});

describe('quota and capacity', () => {
  it('reports how much of the 10M-cell budget is used', async () => {
    const { sheets } = await exporter({
      tabs: [{ title: 'Leads', sheetId: 7, rows: 1000, cols: 26 }],
    });
    const room = await sheets.prepare(LEADS_FLAT);

    expect(room.cellsUsed).toBe(26_000);
    expect(room.cellsFree).toBe(MAX_CELLS_PER_SPREADSHEET - 26_000);
  });

  it('estimates duration from the per-minute write quota', () => {
    // Worth knowing before starting, not by watching a bar crawl.
    expect(estimateMinutes(1_000)).toBeLessThan(1);
    expect(estimateMinutes(5_000_000)).toBeGreaterThan(1);
  });

  it('chunks by serialized size, not row count', () => {
    // 500 short names and 500 long addresses are very different payloads, and
    // the limit that matters is the 180-second processing timeout.
    const small = Array.from({ length: 100 }, () => toRowData({ name: 'a' }, LEADS_FLAT));
    const large = Array.from({ length: 100 }, () =>
      toRowData({ name: 'x'.repeat(5_000) }, LEADS_FLAT),
    );

    expect(chunkBySize(small, 50_000).length).toBeLessThan(chunkBySize(large, 50_000).length);
  });

  it('never emits an empty chunk', () => {
    expect(chunkBySize([], 1_000)).toEqual([]);
    // A single row larger than the limit still has to go somewhere.
    const huge = [toRowData({ name: 'x'.repeat(100_000) }, LEADS_FLAT)];
    expect(chunkBySize(huge, 1_000)).toHaveLength(1);
  });
});

describe('retry', () => {
  it('retries the statuses Google uses for backpressure', () => {
    for (const status of [429, 500, 502, 503, 504]) expect(isRetryable(status)).toBe(true);
    // A permissions problem will never fix itself by waiting.
    for (const status of [400, 401, 403, 404]) expect(isRetryable(status)).toBe(false);
  });

  it('recovers from a burst of 429s', async () => {
    const { mock, sheets } = await exporter();
    mock.failNext(2, 429);

    const result = await sheets.append([{ name: 'Acme' }], LEADS_FLAT, {
      baseMs: 1,
      random: () => 0,
    });

    expect(result.appended).toBe(1);
    expect(result.retries).toBe(2);
    expect(mock.cells()).toHaveLength(1);
  });

  it('gives up on a permissions error instead of hammering', async () => {
    const { mock, sheets } = await exporter();
    mock.failNext(1, 403);

    await expect(
      sheets.append([{ name: 'Acme' }], LEADS_FLAT, { baseMs: 1, attempts: 5 }),
    ).rejects.toThrow();

    // One attempt for the append; nothing repeated.
    const appends = mock.requests.filter(
      (r) => r.method === 'POST' && JSON.stringify(r.body).includes('appendCells'),
    );
    expect(appends).toHaveLength(1);
  });

  it('jitters, so workers sharing one quota do not re-collide', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await withRetry(
      () => {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error('429'), { status: 429 });
        return Promise.resolve('ok');
      },
      {
        baseMs: 100,
        random: () => 0.5,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );

    // Full jitter at random()=0.5 halves each exponential step.
    expect(delays).toEqual([50, 100, 200]);
  });
});

describe('configuration errors', () => {
  it('refuses an empty spreadsheet id with a useful hint', () => {
    expect(() => new SheetsExporter({ spreadsheetId: '  ' })).toThrowError(/spreadsheetId/);
  });

  it('refuses to create a missing tab when told not to', async () => {
    const mock = await startMockSheets({ existingTabs: [] });
    servers.push(mock);
    const sheets = new SheetsExporter({
      spreadsheetId: 'x',
      sheetName: 'Leads',
      rootUrl: mock.url,
      authOverride: 'k',
      createIfMissing: false,
    });

    await expect(sheets.prepare(LEADS_FLAT)).rejects.toThrow(/does not exist/);
  });
});

describe('rebuilding a tab', () => {
  // The sheet is append-only, so a correction to rows already sent (a vendor's
  // address dropped, privacy@ ranked last) needs the tab sent again.
  const schema = { entity: 'x', fields: [text], sql: '' };

  it('blanks the rows below the header rather than deleting them', async () => {
    // Deleting them is refused by real Google once the header is frozen.
    const { mock, sheets } = await exporter({ tabs: [{ title: 'Leads', sheetId: 7, rows: 500 }] });
    expect(await sheets.clearBelowHeader(schema)).toBe(499);
    const sent = mock.requests.flatMap(
      (r) =>
        ((r.body as { requests?: unknown[] } | null)?.requests ?? []) as Record<string, unknown>[],
    );
    expect(sent).toEqual([
      { updateCells: { range: { sheetId: 7, startRowIndex: 1 }, fields: 'userEnteredValue' } },
    ]);
  });

  it('does nothing to a tab that only has its header', async () => {
    const { mock, sheets } = await exporter({ tabs: [{ title: 'Leads', sheetId: 7, rows: 1 }] });
    expect(await sheets.clearBelowHeader(schema)).toBe(0);
    expect(
      mock.requests.some((r) => JSON.stringify(r.body ?? '').includes('deleteDimension')),
    ).toBe(false);
  });
});

describe('the header row', () => {
  const schema = { entity: 'x', fields: [text, number], sql: '' };
  const header = (mock: MockSheets) =>
    (mock.rows('Leads')[0] as { userEnteredValue: { stringValue: string } }[]).map(
      (c) => c.userEnteredValue.stringValue,
    );

  it('is written, styled and frozen on a tab someone emptied or made by hand', async () => {
    const { mock, sheets } = await exporter({ tabs: [{ title: 'Leads', sheetId: 7, values: [] }] });
    await sheets.append([{ name: 'Nina Nails', rating: 4.8 }], schema);

    expect(header(mock)).toEqual(['name', 'rating']);
    expect(mock.rows('Leads')).toHaveLength(2);
    const cell = mock.rows('Leads')[0]![0] as { userEnteredFormat: Record<string, unknown> };
    expect(cell.userEnteredFormat['textFormat']).toMatchObject({ bold: true });
    expect(cell.userEnteredFormat['backgroundColor']).toBeDefined();
    const freeze = mock.requests.some((r) =>
      JSON.stringify(r.body ?? '').includes('"frozenRowCount":1'),
    );
    expect(freeze).toBe(true);
  });

  it('is not written again on a tab that has one', async () => {
    const { mock, sheets } = await exporter();
    await sheets.append([{ name: 'Nina Nails', rating: 4.8 }], schema);
    expect(mock.rows('Leads')).toHaveLength(2);
  });

  it('is not slipped under rows that are already there', async () => {
    // Header cleared by hand, data left: appending a header would put it at
    // the bottom. Leave the tab as it is.
    const row = [{ userEnteredValue: { stringValue: 'Nina Nails' } }];
    const { mock, sheets } = await exporter({
      tabs: [{ title: 'Leads', sheetId: 7, values: [[], row] }],
    });
    await sheets.append([{ name: 'Salon B', rating: 4 }], schema);
    expect(mock.rows('Leads')).toHaveLength(3);
    expect(JSON.stringify(mock.rows('Leads')[0])).toBe('[]');
  });

  it('is written once when the tab is created', async () => {
    const { mock, sheets } = await exporter({ tabs: [] });
    await sheets.append([{ name: 'Nina Nails', rating: 4.8 }], schema);
    expect(header(mock)).toEqual(['name', 'rating']);
    expect(mock.rows('Leads')).toHaveLength(2);
  });
});
