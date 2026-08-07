/**
 * CSV export.
 *
 * The primary bulk path. Sheets is a capped convenience on top of the same data.
 *
 * ## The leading-zero problem, stated honestly
 *
 * The legacy pipeline lost the leading zero on zips. It is worth being precise
 * about why, because the usual advice does not work:
 *
 * A CSV file has no types. `01234` and `"01234"` are both just text on disk —
 * **quoting does not help**, because Excel re-guesses the type when it opens the
 * file and turns both into the number 1234. A UTF-8 BOM does not help either;
 * it only fixes character encoding.
 *
 * There are exactly two things that do work, and both have a cost:
 *
 *  1. `="01234"` — Excel parses this as a formula returning text, so the zeros
 *     survive. But it is *not* portable: pandas, `csv.reader` and most database
 *     loaders see the literal characters `="01234"`.
 *  2. Open the file via Excel's import wizard and mark the column as Text. This
 *     keeps the file clean but is a manual step.
 *
 * So `excelSafeText` is a deliberate choice the caller makes, defaulting to
 * **off** — a clean, portable file — with the flag available when the file is
 * destined to be double-clicked into Excel. Guessing wrong in either direction
 * silently corrupts data, so this is surfaced rather than decided here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FieldDef, ExportRow, RecordSchema } from '../views/index.js';

export interface CsvOptions {
  /**
   * Wrap digit-like identifiers as `="01234"` so Excel preserves leading zeros.
   *
   * Off by default: it produces a file only Excel reads correctly.
   */
  readonly excelSafeText?: boolean;
  /** Prepend a UTF-8 BOM so Excel reads non-ASCII business names correctly. */
  readonly bom?: boolean;
  /** Line ending. Always explicit — never platform-dependent. */
  readonly newline?: '\n' | '\r\n';
  readonly delimiter?: ',';
}

/**
 * Quote a single CSV field per RFC 4180.
 *
 * A field is quoted when it contains the delimiter, a quote, or any newline;
 * embedded quotes are doubled. Fields are also quoted when they have leading or
 * trailing spaces, which some parsers otherwise strip.
 */
export function quoteField(value: string, delimiter = ','): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();

  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Render one value according to its declared kind. */
export function formatValue(
  value: string | number | boolean | null | undefined,
  field: FieldDef,
  options: CsvOptions = {},
): string {
  if (value === null || value === undefined) return '';

  switch (field.kind) {
    case 'timestamp': {
      const ms = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
    }
    case 'boolean':
      return value === 1 || value === true || value === '1' ? 'true' : 'false';
    case 'digits': {
      const text = String(value);
      // The one place the Excel trade-off is applied.
      return options.excelSafeText === true && text !== '' ? `="${text}"` : text;
    }
    case 'number':
      return String(value);
    case 'text':
    default:
      return String(value);
  }
}

/** Render one row, in schema field order. */
export function formatRow(row: ExportRow, schema: RecordSchema, options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  return schema.fields
    .map((field) => quoteField(formatValue(row[field.name], field, options), delimiter))
    .join(delimiter);
}

export function formatHeader(schema: RecordSchema, options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  return schema.fields.map((f) => quoteField(f.name, delimiter)).join(delimiter);
}

/**
 * Append rows to a CSV file, writing the header only when creating it.
 *
 * Appending rather than rewriting is what makes an export resumable: a run that
 * dies halfway leaves a valid file, and the next run continues from the cursor.
 */
export class CsvWriter {
  readonly #newline: string;
  #created: boolean;

  constructor(
    readonly file: string,
    private readonly schema: RecordSchema,
    private readonly options: CsvOptions = {},
  ) {
    this.#newline = options.newline ?? '\n';
    this.#created = fs.existsSync(file) && fs.statSync(file).size > 0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  get isNew(): boolean {
    return !this.#created;
  }

  write(rows: readonly ExportRow[]): number {
    if (rows.length === 0) return 0;

    const lines: string[] = [];
    if (!this.#created) {
      // The BOM goes before the header and only on creation, or it would appear
      // mid-file on every append.
      const prefix = this.options.bom === true ? '\uFEFF' : '';
      lines.push(prefix + formatHeader(this.schema, this.options));
      this.#created = true;
    }
    for (const row of rows) lines.push(formatRow(row, this.schema, this.options));

    fs.appendFileSync(this.file, lines.join(this.#newline) + this.#newline, 'utf8');
    return rows.length;
  }
}

/**
 * Split rows into per-group files.
 *
 * `--split-by state` produces one file per state, which is how these lists are
 * usually worked: a caller takes one state at a time.
 */
export function groupKeyFor(row: ExportRow, splitBy: string | null): string | null {
  if (splitBy === null) return null;
  const value = row[splitBy];
  if (value === null || value === undefined || value === '') return 'unknown';
  return String(value)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, 32);
}
