import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CsvWriter,
  formatHeader,
  formatRow,
  formatValue,
  groupKeyFor,
  quoteField,
} from '../src/exporters/csv.js';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { ExportsRepository } from '../src/db/repositories/exports.js';
import { LEADS_FLAT, VIEWS } from '../src/views/index.js';
import type { FieldDef, RecordSchema } from '../src/views/index.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const SCHEMA: RecordSchema = {
  entity: 'test',
  fields: [
    { name: 'name', kind: 'text' },
    { name: 'zip', kind: 'digits' },
    { name: 'rating', kind: 'number' },
    { name: 'active', kind: 'boolean' },
    { name: 'seen', kind: 'timestamp' },
  ],
  sql: '',
};

const digits: FieldDef = { name: 'zip', kind: 'digits' };
const text: FieldDef = { name: 'name', kind: 'text' };

describe('CSV quoting', () => {
  it('quotes only what RFC 4180 requires', () => {
    expect(quoteField('plain')).toBe('plain');
    expect(quoteField('has,comma')).toBe('"has,comma"');
    expect(quoteField('has"quote')).toBe('"has""quote"');
    expect(quoteField('has\nnewline')).toBe('"has\nnewline"');
  });

  it('quotes values with surrounding space, which some parsers strip', () => {
    expect(quoteField(' padded ')).toBe('" padded "');
  });

  it('handles a business name containing both a comma and a quote', () => {
    expect(quoteField('Bob\'s "Best" Plumbing, Inc')).toBe('"Bob\'s ""Best"" Plumbing, Inc"');
  });
});

describe('leading zeros', () => {
  it('does not damage the value by default', () => {
    expect(formatValue('02108', digits)).toBe('02108');
  });

  it('wraps digit fields as an Excel formula when asked', () => {
    // Quoting alone does not survive Excel — it re-guesses the type on open and
    // turns "02108" into 2108. `="02108"` is the only in-file form that works.
    expect(formatValue('02108', digits, { excelSafeText: true })).toBe('="02108"');
  });

  it('leaves ordinary text alone even in Excel-safe mode', () => {
    expect(formatValue('Acme Ltd', text, { excelSafeText: true })).toBe('Acme Ltd');
  });

  it('never converts a CID to a number', () => {
    // 13019781180686529338 exceeds float precision; passing it through Number
    // corrupts it from the 17th digit.
    const cid = '13019781180686529338';
    expect(formatValue(cid, { name: 'cid', kind: 'digits' })).toBe(cid);
  });
});

describe('value formatting', () => {
  it('renders timestamps as ISO 8601', () => {
    expect(formatValue(1_700_000_000_000, { name: 'seen', kind: 'timestamp' })).toBe(
      '2023-11-14T22:13:20.000Z',
    );
  });

  it('renders SQLite integer booleans as true/false', () => {
    const field: FieldDef = { name: 'active', kind: 'boolean' };
    expect(formatValue(1, field)).toBe('true');
    expect(formatValue(0, field)).toBe('false');
  });

  it('renders null and undefined as empty, never the string "null"', () => {
    expect(formatValue(null, text)).toBe('');
    expect(formatValue(undefined, text)).toBe('');
  });
});

describe('row rendering', () => {
  it('follows schema field order regardless of object key order', () => {
    const row = { seen: 0, name: 'Acme', zip: '02108', rating: 4.5, active: 1 };
    expect(formatRow(row, SCHEMA)).toBe('Acme,02108,4.5,true,1970-01-01T00:00:00.000Z');
  });

  it('emits an empty cell for a field the row does not have', () => {
    expect(formatRow({ name: 'Acme' }, SCHEMA)).toBe('Acme,,,,');
  });

  it('writes headers from the schema', () => {
    expect(formatHeader(SCHEMA)).toBe('name,zip,rating,active,seen');
  });
});

describe('CsvWriter', () => {
  it('writes the header once and appends thereafter', () => {
    const file = path.join(tempDir(), 'out.csv');
    const writer = new CsvWriter(file, SCHEMA);

    writer.write([{ name: 'A', zip: '01', rating: 1, active: 1, seen: 0 }]);
    writer.write([{ name: 'B', zip: '02', rating: 2, active: 0, seen: 0 }]);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('name,zip');
    expect(lines.filter((l) => l.startsWith('name,')).length).toBe(1);
  });

  it('appends without a second header when reopened', () => {
    // This is what makes a resumed export produce a valid file.
    const file = path.join(tempDir(), 'out.csv');
    new CsvWriter(file, SCHEMA).write([{ name: 'A' }]);
    new CsvWriter(file, SCHEMA).write([{ name: 'B' }]);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('name,')).length).toBe(1);
  });

  it('writes the BOM once, before the header only', () => {
    const file = path.join(tempDir(), 'out.csv');
    const writer = new CsvWriter(file, SCHEMA, { bom: true });
    writer.write([{ name: 'A' }]);
    writer.write([{ name: 'B' }]);

    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith('﻿')).toBe(true);
    expect(content.split('﻿')).toHaveLength(2);
  });

  it('uses the requested line ending, never the platform default', () => {
    const file = path.join(tempDir(), 'out.csv');
    new CsvWriter(file, SCHEMA, { newline: '\r\n' }).write([{ name: 'A' }]);
    expect(fs.readFileSync(file, 'utf8')).toContain('\r\n');
  });

  it('creates the output directory', () => {
    const file = path.join(tempDir(), 'deep', 'nested', 'out.csv');
    new CsvWriter(file, SCHEMA).write([{ name: 'A' }]);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('split-by grouping', () => {
  it('groups by a column value', () => {
    expect(groupKeyFor({ state: 'AL' }, 'state')).toBe('AL');
  });

  it('buckets missing values rather than dropping the row', () => {
    expect(groupKeyFor({ state: null }, 'state')).toBe('unknown');
    expect(groupKeyFor({}, 'state')).toBe('unknown');
  });

  it('sanitizes the value, since it becomes a filename', () => {
    expect(groupKeyFor({ city: 'St. Louis/East' }, 'city')).toBe('St-Louis-East');
  });

  it('returns null when not splitting', () => {
    expect(groupKeyFor({ state: 'AL' }, null)).toBeNull();
  });
});

describe('--full replaces the file', () => {
  it('does not leave two copies of every row', () => {
    // The cursor restarts, so the file must too. Appending would silently
    // double the list, and a CSV has no way to say it started over midway.
    const file = path.join(tempDir(), 'out.csv');
    new CsvWriter(file, SCHEMA).write([{ name: 'first', zip: '01', rating: 1 }]);
    new CsvWriter(file, SCHEMA, { replace: true }).write([
      { name: 'second', zip: '02', rating: 2 },
    ]);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // header + one row
    expect(lines[1]).toContain('second');
    expect(lines[1]).not.toContain('first');
  });

  it('leaves a file alone when the writer never writes', () => {
    // --split-by creates a writer per group; a group with no rows this run must
    // not wipe what an earlier run put there.
    const file = path.join(tempDir(), 'out.csv');
    new CsvWriter(file, SCHEMA).write([{ name: 'kept', zip: '01', rating: 1 }]);
    new CsvWriter(file, SCHEMA, { replace: true }).write([]);

    expect(fs.readFileSync(file, 'utf8')).toContain('kept');
  });
});

describe('export cursors', () => {
  function fresh(): ExportsRepository {
    const driver = openDatabase({ file: path.join(tempDir(), 'x.sqlite') });
    migrate(driver);
    return new ExportsRepository(driver);
  }

  it('starts at zero', () => {
    expect(fresh().lastId('csv', '/tmp/x', 'leads-flat')).toBe(0);
  });

  it('advances and accumulates a row total', () => {
    const cursors = fresh();
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 100, lastSubId: 0 }, 100);
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 250, lastSubId: 0 }, 150);

    expect(cursors.lastId('csv', '/tmp/x', 'leads-flat')).toBe(250);
    expect(cursors.position('csv', '/tmp/x', 'leads-flat')?.rows_total).toBe(250);
  });

  it('never rewinds', () => {
    // Two exporters running at once must not let a slower one reset the
    // watermark and re-export everything the faster one already wrote.
    const cursors = fresh();
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 500, lastSubId: 0 }, 500);
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 100, lastSubId: 0 }, 0);
    expect(cursors.lastId('csv', '/tmp/x', 'leads-flat')).toBe(500);
  });

  it('keeps targets and entities independent', () => {
    const cursors = fresh();
    cursors.advance('csv', '/tmp/a', 'leads-flat', { lastId: 100, lastSubId: 0 }, 100);

    expect(cursors.lastId('csv', '/tmp/b', 'leads-flat')).toBe(0);
    expect(cursors.lastId('csv', '/tmp/a', 'emails')).toBe(0);
    expect(cursors.lastId('sheets', '/tmp/a', 'leads-flat')).toBe(0);
  });

  it('resets for a full re-export', () => {
    const cursors = fresh();
    cursors.advance('csv', '/tmp/x', 'leads-flat', { lastId: 100, lastSubId: 0 }, 100);
    cursors.reset('csv', '/tmp/x', 'leads-flat');
    expect(cursors.lastId('csv', '/tmp/x', 'leads-flat')).toBe(0);
  });
});

describe('view schemas', () => {
  it('exposes the documented entities', () => {
    expect(Object.keys(VIEWS).sort()).toEqual(['businesses', 'emails', 'leads-flat']);
  });

  it('marks every identifier-shaped field as digits, not number', () => {
    // A zip, phone or CID rendered as a number is corrupted: leading zeros are
    // lost and a 20-digit CID loses precision.
    for (const schema of Object.values(VIEWS)) {
      for (const field of schema.fields) {
        if (/^(zip|postal|phone|cid|fips)/.test(field.name) || field.name.endsWith('_phone')) {
          expect(field.kind).toBe('digits');
        }
      }
    }
  });

  it('selects an id column for every view, since it is the cursor', () => {
    for (const schema of Object.values(VIEWS)) {
      expect(schema.sql).toMatch(/AS id/i);
      expect(schema.sql).toContain(':lastId');
      expect(schema.sql).toContain(':limit');
    }
  });

  it('excludes junk emails from every view that joins them', () => {
    // Junk stays in the database for auditing but must never reach an export.
    for (const schema of [VIEWS['leads-flat'], VIEWS['emails']]) {
      expect(schema?.sql).toMatch(/is_junk\s*=\s*0/);
    }
  });

  it('orders by the cursor column so pagination cannot skip rows', () => {
    expect(LEADS_FLAT.sql).toMatch(/ORDER BY b\.id/);
  });
});
