/**
 * Google Sheets export.
 *
 * A shared, always-current view for people who will never open a terminal. It
 * is a *convenience* layer over the database, not a second source of truth: rows
 * are already committed before anything is sent, so a failed append loses
 * nothing and simply resumes.
 *
 * Four constraints shape every decision here, and each one bites silently if
 * ignored:
 *
 * ## 1. `valueInputOption: RAW` does not protect leading zeros
 *
 * This is the single most repeated piece of wrong advice about Sheets. RAW
 * governs how the API treats a *string* you send — but by the time you call
 * `values.append`, a zip has usually already become the number 2108 in your own
 * JSON. The coercion happens client-side, before the API is involved.
 *
 * The hard guarantee is `appendCells` with an explicit
 * `userEnteredValue.stringValue` per cell. That is a typed instruction Sheets
 * cannot reinterpret, so `02108` and a 20-digit CID both survive exactly.
 *
 * ## 2. One `batchUpdate` costs one write, whatever it contains
 *
 * The quota is 60 writes per minute *per user*, and a service account is a
 * user, so this is not a limit you can shard around with more workers. Sending
 * 500 rows as 500 `values.append` calls burns eight minutes of quota; sending
 * them as one `batchUpdate` costs a single write. That is an N-fold multiplier,
 * not a micro-optimisation.
 *
 * ## 3. A spreadsheet holds 10 million cells, total
 *
 * At ~20 columns that is ~500,000 rows — for the whole file, including every
 * other tab. A full sweep of ~1M businesses does not fit, so the exporter
 * refuses rather than failing at 78% with a partially-written sheet. CSV
 * remains the bulk path.
 *
 * ## 4. Requests time out at 180 seconds
 *
 * So chunks are bounded by serialized *bytes*, not row count: 500 rows of short
 * business names and 500 rows with long addresses are very different payloads.
 */
import { sheets as sheetsApi, auth as googleAuth } from '@googleapis/sheets';
import type { sheets_v4 } from '@googleapis/sheets';
import type { ExportRow, FieldDef, RecordSchema } from '../views/index.js';
import { ConfigError } from '../core/errors/taxonomy.js';

/** Sheets' documented ceiling for one spreadsheet, across all tabs. */
export const MAX_CELLS_PER_SPREADSHEET = 10_000_000;

/** Stay well inside the 180s per-request processing limit. */
const MAX_CHUNK_BYTES = 1_000_000;

/** The write quota is per user, and a service account is one user. */
export const WRITES_PER_MINUTE = 60;

export interface SheetsAuthOptions {
  /**
   * Path to a service-account JSON key.
   *
   * Optional on purpose. Many organisations now block key creation outright:
   * `iam.disableServiceAccountKeyCreation` is enforced by default for GCP orgs
   * created on or after 2024-05-03. Omit this and Application Default
   * Credentials are used instead, which is both the keyless path and the one
   * that works under that policy.
   */
  readonly credentialsFile?: string;
}

export interface SheetsExportOptions extends SheetsAuthOptions {
  readonly spreadsheetId: string;
  readonly sheetName?: string;
  /** Override the API endpoint. Used by tests to point at a local mock. */
  readonly rootUrl?: string;
  /**
   * Pre-built credentials, bypassing the normal auth flow.
   *
   * Exists so tests can drive the *real* Sheets client against a local mock:
   * the OAuth token exchange always goes to Google's own endpoint regardless of
   * `rootUrl`, so without this the client would try to authenticate for real.
   * Everything worth verifying — cell types, batching, retry — is downstream of
   * auth, so stubbing it costs no meaningful coverage.
   */
  readonly authOverride?: string;
  /** Create the tab if it is missing. */
  readonly createIfMissing?: boolean;
  readonly logger?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface AppendResult {
  readonly appended: number;
  readonly requests: number;
  readonly retries: number;
}

type CellData = sheets_v4.Schema$CellData;

/**
 * Convert one value to a typed Sheets cell.
 *
 * The `digits` kind is the reason this function exists: those values are
 * identifiers made of digits — zips, phones, CIDs — and every one of them is
 * damaged by being treated as a number. They are sent as `stringValue`, which
 * Sheets stores verbatim.
 */
export function toCell(
  value: string | number | boolean | null | undefined,
  field: FieldDef,
): CellData {
  if (value === null || value === undefined) return {};

  switch (field.kind) {
    case 'digits':
      // Explicitly a string. This is the guarantee; RAW is not.
      return { userEnteredValue: { stringValue: String(value) } };

    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n)
        ? { userEnteredValue: { numberValue: n } }
        : { userEnteredValue: { stringValue: String(value) } };
    }

    case 'boolean':
      return { userEnteredValue: { boolValue: value === 1 || value === '1' || value === true } };

    case 'timestamp': {
      const ms = typeof value === 'number' ? value : Number(value);
      return {
        userEnteredValue: {
          // ISO text rather than a Sheets serial date: unambiguous across
          // locales and timezones, and readable without applying a format.
          stringValue: Number.isFinite(ms) ? new Date(ms).toISOString() : String(value),
        },
      };
    }

    case 'text':
    default: {
      const text = String(value);
      // A leading '=' or '+' would be parsed as a formula. Business names
      // beginning with '+' are rare but real, and a broken formula in a shared
      // sheet looks like corrupted data.
      return {
        userEnteredValue: {
          stringValue: /^[=+\-@]/.test(text) ? `'${text}` : text,
        },
      };
    }
  }
}

export function toRowData(row: ExportRow, schema: RecordSchema): sheets_v4.Schema$RowData {
  return { values: schema.fields.map((field) => toCell(row[field.name], field)) };
}

/**
 * Split rows into chunks bounded by serialized size.
 *
 * By bytes, not rows: the 180-second processing limit is about payload weight,
 * and row counts are a poor proxy when one listing has a two-word name and the
 * next has a full address and a long URL.
 */
export function chunkBySize(
  rows: readonly sheets_v4.Schema$RowData[],
  maxBytes = MAX_CHUNK_BYTES,
): sheets_v4.Schema$RowData[][] {
  const chunks: sheets_v4.Schema$RowData[][] = [];
  let current: sheets_v4.Schema$RowData[] = [];
  let size = 0;

  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Retry only what is worth retrying. */
export function isRetryable(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more than usual here: the quota is per *user*, so every worker
 * shares one budget and they all get 429'd at the same instant. Backing off by
 * identical amounts guarantees they collide again on the next tick.
 */
export async function withRetry<T>(
  work: () => Promise<T>,
  options: RetryOptions = {},
): Promise<{ value: T; retries: number }> {
  const attempts = options.attempts ?? 6;
  const baseMs = options.baseMs ?? 1_000;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { value: await work(), retries: attempt - 1 };
    } catch (error) {
      const status =
        (error as { status?: number; code?: number }).status ?? (error as { code?: number }).code;
      if (!isRetryable(typeof status === 'number' ? status : undefined)) throw error;
      lastError = error;
      if (attempt < attempts) {
        await sleep(Math.round(random() * baseMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Appends rows to one tab of one spreadsheet.
 *
 * Serialized through an internal promise chain: several workers appending at
 * once would interleave `appendCells` calls and scramble row order. The lock is
 * in-process only, which is the honest scope — two `gms export sheets`
 * processes would still race, and the `row_uid` column is what makes that
 * detectable afterwards.
 */
/** #2E3A46. */
const HEADER_BACKGROUND = { red: 0.18, green: 0.227, blue: 0.275 } as const;

export class SheetsExporter {
  readonly #api: sheets_v4.Sheets;
  readonly #spreadsheetId: string;
  readonly #sheetName: string;
  #lock: Promise<unknown> = Promise.resolve();
  #sheetId: number | null = null;
  /** Rows the tab had when prepared, header included. */
  #rowCount = 0;

  constructor(private readonly options: SheetsExportOptions) {
    if (options.spreadsheetId.trim() === '') {
      throw new ConfigError('exporters.sheets.spreadsheetId is required.', {
        code: 'CONFIG_INVALID',
        hint: 'Copy it from the sheet URL: docs.google.com/spreadsheets/d/<THIS>/edit',
      });
    }

    this.#spreadsheetId = options.spreadsheetId;
    this.#sheetName = options.sheetName ?? 'Leads';

    const client =
      options.authOverride ??
      new googleAuth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        // Omitted means Application Default Credentials — the keyless path,
        // and the only one that works where key creation is blocked by policy.
        ...(options.credentialsFile !== undefined && { keyFile: options.credentialsFile }),
      });

    this.#api = sheetsApi({
      version: 'v4',
      auth: client,
      ...(options.rootUrl !== undefined && { rootUrl: options.rootUrl }),
    });
  }

  /** Run `work` with the append lock held, so ordering is deterministic. */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(work, work);
    // Swallow rejections on the chain itself; the caller still sees them.
    this.#lock = next.catch(() => undefined);
    return next;
  }

  /**
   * Check the sheet is reachable and has room, creating the tab if asked.
   *
   * Returns the remaining cell budget so the caller can refuse a run that would
   * not fit rather than discovering it partway through.
   */
  async prepare(schema: RecordSchema): Promise<{ cellsUsed: number; cellsFree: number }> {
    const { data } = await this.#api.spreadsheets.get({
      spreadsheetId: this.#spreadsheetId,
      fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
    });

    const tabs = data.sheets ?? [];
    const cellsUsed = tabs.reduce((total, tab) => {
      const grid = tab.properties?.gridProperties;
      return total + (grid?.rowCount ?? 0) * (grid?.columnCount ?? 0);
    }, 0);

    const existing = tabs.find((tab) => tab.properties?.title === this.#sheetName);

    if (existing === undefined) {
      if (this.options.createIfMissing === false) {
        throw new ConfigError(`Sheet tab "${this.#sheetName}" does not exist.`, {
          code: 'CONFIG_INVALID',
          hint: 'Create the tab, or set exporters.sheets.createIfMissing: true',
        });
      }
      this.#sheetId = await this.#createTab(schema);
    } else {
      this.#sheetId = existing.properties?.sheetId ?? null;
      this.#rowCount = existing.properties?.gridProperties?.rowCount ?? 0;
      // A tab made by hand, or emptied to start over, gets the header a tab
      // made here would have had. Without this, rows went in from row 1 with
      // no header at all.
      if (this.#sheetId !== null && (await this.#isEmpty())) {
        await this.#writeHeader(schema, this.#sheetId);
      }
    }

    return { cellsUsed, cellsFree: Math.max(0, MAX_CELLS_PER_SPREADSHEET - cellsUsed) };
  }

  /** Rows below the header as of {@link prepare}; each can be filled without new cells. */
  get rowsBelowHeader(): number {
    return Math.max(0, this.#rowCount - 1);
  }

  /**
   * Blank every row below the header, so the tab can be sent again from scratch.
   *
   * Values only. Deleting the rows is not an option: Google refuses it with
   * "Sorry, it is not possible to delete all non-frozen rows", and this tool
   * freezes the header. Blanking also keeps the rows' colours and the grid, and
   * an append lands straight under the header — both checked against the live
   * API. Only for a tab this tool writes: the caller decides that.
   */
  async clearBelowHeader(schema: RecordSchema, retry: RetryOptions = {}): Promise<number> {
    if (this.#sheetId === null) await this.prepare(schema);
    const sheetId = this.#sheetId;
    if (sheetId === null) throw new Error('sheet tab was not prepared');
    const rows = this.rowsBelowHeader;
    if (rows === 0) return 0;
    await withRetry(
      () =>
        this.#api.spreadsheets.batchUpdate({
          spreadsheetId: this.#spreadsheetId,
          requestBody: {
            requests: [
              // With no `rows` given, updateCells clears `fields` across `range`.
              { updateCells: { range: { sheetId, startRowIndex: 1 }, fields: 'userEnteredValue' } },
            ],
          },
        }),
      retry,
    );
    return rows;
  }

  async #createTab(schema: RecordSchema): Promise<number> {
    const { data } = await this.#api.spreadsheets.batchUpdate({
      spreadsheetId: this.#spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: this.#sheetName,
                gridProperties: {
                  columnCount: schema.fields.length,
                  // A frozen header row is what makes a long sheet usable for
                  // the people who will actually read it.
                  frozenRowCount: 1,
                },
              },
            },
          },
        ],
      },
    });

    const sheetId = data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (sheetId === null || sheetId === undefined) {
      throw new Error(`could not create sheet tab "${this.#sheetName}"`);
    }

    await this.#writeHeader(schema, sheetId);
    return sheetId;
  }

  /**
   * Whether the tab holds nothing yet: its first two rows are blank.
   *
   * Two rows, not one, so a sheet whose header was cleared but whose rows
   * remain is not mistaken for empty — a header appended there would land
   * below the data. Such a tab is left as it is.
   */
  async #isEmpty(): Promise<boolean> {
    const { data } = await this.#api.spreadsheets.values.get({
      spreadsheetId: this.#spreadsheetId,
      range: `'${this.#sheetName.replace(/'/g, "''")}'!1:2`,
    });
    const blank = (cell: unknown): boolean =>
      cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
    return (data.values ?? []).every((row: unknown[]) => row.every(blank));
  }

  /** The header row, styled, as row 1, and frozen so it stays in view. */
  async #writeHeader(schema: RecordSchema, sheetId: number): Promise<void> {
    await this.#api.spreadsheets.batchUpdate({
      spreadsheetId: this.#spreadsheetId,
      requestBody: {
        requests: [
          {
            appendCells: {
              sheetId,
              rows: [this.#headerRow(schema)],
              fields: 'userEnteredValue,userEnteredFormat(textFormat,backgroundColor)',
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
        ],
      },
    });
    this.options.logger?.info({ tab: this.#sheetName }, 'wrote the header row');
  }

  #headerRow(schema: RecordSchema): sheets_v4.Schema$RowData {
    return {
      values: schema.fields.map((field) => ({
        userEnteredValue: { stringValue: field.name },
        userEnteredFormat: {
          // White on dark slate: unmistakably the header, and readable printed.
          backgroundColor: HEADER_BACKGROUND,
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
        },
      })),
    };
  }

  async #appendChunk(rows: sheets_v4.Schema$RowData[], sheetId: number): Promise<void> {
    await this.#api.spreadsheets.batchUpdate({
      spreadsheetId: this.#spreadsheetId,
      requestBody: {
        requests: [
          {
            // appendCells, not values.append: it takes typed cells, so the
            // string/number decision is ours rather than Sheets' guess.
            appendCells: {
              sheetId,
              rows,
              fields: 'userEnteredValue,userEnteredFormat.textFormat',
            },
          },
        ],
      },
    });
  }

  /**
   * Append rows, chunked and retried.
   *
   * Resolves only once every chunk is confirmed written, so the caller can
   * advance its cursor knowing the data is there.
   */
  async append(
    rows: readonly ExportRow[],
    schema: RecordSchema,
    retry: RetryOptions = {},
  ): Promise<AppendResult> {
    if (rows.length === 0) return { appended: 0, requests: 0, retries: 0 };
    if (this.#sheetId === null) await this.prepare(schema);
    const sheetId = this.#sheetId;
    if (sheetId === null) throw new Error('sheet tab was not prepared');

    return this.#serialize(async () => {
      const chunks = chunkBySize(rows.map((row) => toRowData(row, schema)));
      let retries = 0;

      for (const [index, chunk] of chunks.entries()) {
        const result = await withRetry(() => this.#appendChunk(chunk, sheetId), retry);
        retries += result.retries;
        this.options.logger?.info(
          { chunk: index + 1, of: chunks.length, rows: chunk.length },
          'appended to sheet',
        );
      }

      return { appended: rows.length, requests: chunks.length, retries };
    });
  }
}

/**
 * How long an export will take, given the per-minute write quota.
 *
 * Surfaced before starting because "this will take 40 minutes" is something to
 * learn up front, not by watching a progress bar crawl.
 */
export function estimateMinutes(rowCount: number, bytesPerRow = 400): number {
  const rowsPerRequest = Math.max(1, Math.floor(MAX_CHUNK_BYTES / bytesPerRow));
  const requests = Math.ceil(rowCount / rowsPerRequest);
  return requests / WRITES_PER_MINUTE;
}
