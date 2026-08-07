/**
 * `gms export` — write results out.
 *
 * Exporters are subscribers to the database, not the source of truth. That is
 * why a failed export cannot lose data: the rows are already committed, and the
 * cursor simply has not advanced. The legacy Apps Script wrote straight to
 * Sheets, so a failed write dropped a listing permanently.
 */
import path from 'node:path';
import type { ResolvedConfig } from '../../config/schema.js';
import { AppError } from '../../core/errors/taxonomy.js';
import { displayPath, resolvePath } from '../../core/util/paths.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { ExportsRepository } from '../../db/repositories/exports.js';
import { CsvWriter, groupKeyFor } from '../../exporters/csv.js';
import { SheetsExporter, estimateMinutes } from '../../exporters/sheets.js';
import { VIEWS, readRows, type ExportRow } from '../../views/index.js';
import { formatBytes, heading, keyValue, style, symbol } from '../output.js';
import fs from 'node:fs';

export interface ExportCsvOptions {
  readonly config: ResolvedConfig;
  readonly entity?: string;
  readonly outDir?: string;
  /** Re-export everything, ignoring the stored cursor. */
  readonly full?: boolean;
  /** Column to split files on, e.g. `state`. */
  readonly splitBy?: string;
  readonly excelSafe?: boolean;
  readonly bom?: boolean;
  readonly crlf?: boolean;
  readonly json?: boolean;
}

const PAGE_SIZE = 1_000;

export function runExportCsv(options: ExportCsvOptions): void {
  const entity = options.entity ?? 'leads-flat';
  const schema = VIEWS[entity];
  if (schema === undefined) {
    throw new AppError(`Unknown entity: ${entity}`, {
      code: 'CONFIG_INVALID',
      hint: `Available: ${Object.keys(VIEWS).join(', ')}`,
    });
  }

  const outDir = options.outDir ?? options.config.paths.exportsDir;
  const driver = openDatabaseFromConfig(options.config);
  const cursors = new ExportsRepository(driver);
  const target = path.resolve(outDir);

  try {
    if (options.full === true) cursors.reset('csv', target, entity);

    const startId = cursors.lastId('csv', target, entity);
    const writers = new Map<string, CsvWriter>();
    const csvOptions = {
      excelSafeText: options.excelSafe === true,
      bom: options.bom !== false,
      newline: options.crlf === true ? ('\r\n' as const) : ('\n' as const),
    };

    let lastId = startId;
    let written = 0;

    for (;;) {
      const rows = readRows(driver, schema, lastId, PAGE_SIZE);
      if (rows.length === 0) break;

      // Group first, then write once per file: appending per row would reopen
      // and re-stat the file for every record.
      const byGroup = new Map<string, ExportRow[]>();
      for (const row of rows) {
        const key = groupKeyFor(row, options.splitBy ?? null) ?? '';
        const list = byGroup.get(key) ?? [];
        list.push(row);
        byGroup.set(key, list);
      }

      for (const [group, groupRows] of byGroup) {
        const file =
          group === ''
            ? path.join(target, `${entity}.csv`)
            : path.join(target, `${entity}-${group}.csv`);

        let writer = writers.get(file);
        if (writer === undefined) {
          writer = new CsvWriter(file, schema, csvOptions);
          writers.set(file, writer);
        }
        written += writer.write(groupRows);
      }

      lastId = rows.at(-1)?.id ?? lastId;

      // Advance only after the rows are on disk. A crash here re-exports this
      // page next time, which is far better than skipping it.
      cursors.advance('csv', target, entity, lastId, rows.length);

      if (rows.length < PAGE_SIZE) break;
    }

    const files = [...writers.keys()].map((file) => ({
      file,
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    }));

    if (options.json === true) {
      console.log(JSON.stringify({ entity, written, lastId, files }, null, 2));
      return;
    }

    if (written === 0) {
      console.log(
        style.grey(
          startId > 0
            ? `Nothing new to export — cursor is at ${startId}. Use --full to re-export.`
            : 'Nothing to export yet. Run `gms run` first.',
        ),
      );
      return;
    }

    console.log(heading('Export'));
    console.log(
      keyValue([
        ['entity', entity],
        ['rows', written.toLocaleString()],
        ['cursor', `${startId} -> ${lastId}`],
      ]),
    );

    console.log(heading('Files'));
    console.log(keyValue(files.map((f) => [displayPath(f.file), formatBytes(f.bytes)] as const)));

    console.log(`\n${symbol.ok} ${written.toLocaleString()} row(s) exported`);
    if (csvOptions.excelSafeText) {
      console.log(
        style.grey('Written in Excel-safe form (="01234"), which only Excel reads correctly.'),
      );
    } else {
      console.log(
        style.grey(
          'Zips and phones are plain text. Excel will strip leading zeros on\n' +
            'double-click — use --excel-safe, or import with the column set to Text.',
        ),
      );
    }
  } finally {
    driver.close();
  }
}

export interface ExportSheetsOptions {
  readonly config: ResolvedConfig;
  readonly entity?: string;
  readonly spreadsheetId?: string;
  readonly sheetName?: string;
  readonly full?: boolean;
  readonly json?: boolean;
}

/**
 * `gms export sheets` — push results to a shared spreadsheet.
 *
 * The team-visible view. Deliberately capped and cursor-driven: the sheet is a
 * window onto the database, and the database stays the source of truth.
 */
export async function runExportSheets(options: ExportSheetsOptions): Promise<void> {
  const entity = options.entity ?? 'leads-flat';
  const schema = VIEWS[entity];
  if (schema === undefined) {
    throw new AppError(`Unknown entity: ${entity}`, {
      code: 'CONFIG_INVALID',
      hint: `Available: ${Object.keys(VIEWS).join(', ')}`,
    });
  }

  const settings = options.config.exporters.sheets;
  const spreadsheetId = options.spreadsheetId ?? settings.spreadsheetId;
  if (spreadsheetId === undefined || spreadsheetId.trim() === '') {
    throw new AppError('No spreadsheet configured.', {
      code: 'CONFIG_INVALID',
      hint:
        'Set exporters.sheets.spreadsheetId, or pass --spreadsheet-id.\n' +
        'It is the long id in the sheet URL: docs.google.com/spreadsheets/d/<THIS>/edit',
    });
  }

  const sheetName = options.sheetName ?? settings.sheetName;
  const driver = openDatabaseFromConfig(options.config);
  const cursors = new ExportsRepository(driver);

  try {
    if (options.full === true) cursors.reset('sheets', spreadsheetId, entity);
    const startId = cursors.lastId('sheets', spreadsheetId, entity);

    const exporter = new SheetsExporter({
      spreadsheetId,
      sheetName,
      createIfMissing: settings.createIfMissing,
      ...(settings.credentialsFile !== undefined && {
        credentialsFile: resolvePath(settings.credentialsFile, options.config.paths.root),
      }),
    });

    const room = await exporter.prepare(schema);
    const pending = countPending(driver, schema, startId);

    if (pending === 0) {
      console.log(
        style.grey(
          startId > 0
            ? `Nothing new — the sheet is up to date at row ${startId}.`
            : 'Nothing to export yet. Collect some businesses first.',
        ),
      );
      return;
    }

    // Refuse rather than fail partway through with a half-written sheet.
    if (pending > settings.maxRows) {
      throw new AppError(
        `${pending.toLocaleString()} rows exceeds the ${settings.maxRows.toLocaleString()}-row limit for Sheets.`,
        {
          code: 'CONFIG_INVALID',
          hint:
            'A spreadsheet holds 10 million cells in total, and one service account may write\n' +
            '60 times a minute. Use `gms export csv` for bulk, or raise\n' +
            'exporters.sheets.maxRows if you are sure it fits.',
        },
      );
    }

    const cellsNeeded = pending * schema.fields.length;
    if (cellsNeeded > room.cellsFree) {
      throw new AppError(
        `This export needs ${cellsNeeded.toLocaleString()} cells but the spreadsheet has ${room.cellsFree.toLocaleString()} free.`,
        { code: 'CONFIG_INVALID', hint: 'Use a fresh spreadsheet, or export to CSV.' },
      );
    }

    console.log(
      keyValue([
        ['spreadsheet', spreadsheetId],
        ['tab', sheetName],
        ['rows to send', pending.toLocaleString()],
        ['estimated', `${estimateMinutes(pending).toFixed(1)} min at 60 writes/min`],
      ]),
    );

    let lastId = startId;
    let written = 0;
    let requests = 0;
    let retries = 0;

    for (;;) {
      const rows = readRows(driver, schema, lastId, PAGE_SIZE);
      if (rows.length === 0) break;

      const result = await exporter.append(rows, schema);
      written += result.appended;
      requests += result.requests;
      retries += result.retries;

      lastId = rows.at(-1)?.id ?? lastId;
      // Only after Sheets confirmed the write.
      cursors.advance('sheets', spreadsheetId, entity, lastId, rows.length);

      if (rows.length < PAGE_SIZE) break;
    }

    if (options.json === true) {
      console.log(JSON.stringify({ entity, written, requests, retries, lastId }, null, 2));
      return;
    }

    console.log(heading('Sent'));
    console.log(
      keyValue([
        ['rows', written.toLocaleString()],
        ['api requests', String(requests)],
        ['retries', String(retries)],
        ['cursor', `${startId} -> ${lastId}`],
      ]),
    );
    console.log(
      `\n${symbol.ok} ${written.toLocaleString()} row(s) in ` +
        style.cyan(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`),
    );
  } finally {
    driver.close();
  }
}

/** How many rows a view would yield beyond the cursor. */
function countPending(
  driver: ReturnType<typeof openDatabaseFromConfig>,
  schema: (typeof VIEWS)[string],
  lastId: number,
): number {
  // Wrapping the view keeps one definition of what a row is.
  const sql = schema.sql.replace(/LIMIT :limit/, 'LIMIT -1');
  return (
    driver.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`).get({ lastId, limit: -1 })
      ?.n ?? 0
  );
}

/** `gms export status` — where each exporter has reached. */
export function runExportStatus(options: { config: ResolvedConfig; json?: boolean }): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const cursors = new ExportsRepository(driver).all();

    if (options.json === true) {
      console.log(JSON.stringify(cursors, null, 2));
      return;
    }
    if (cursors.length === 0) {
      console.log(style.grey('Nothing exported yet.'));
      return;
    }

    console.log(heading('Export cursors'));
    for (const cursor of cursors) {
      console.log(
        `  ${style.bold(cursor.exporter.padEnd(8))} ${cursor.entity.padEnd(12)} ` +
          `id ${String(cursor.last_id).padStart(8)}  ${String(cursor.rows_total).padStart(8)} rows  ` +
          style.grey(displayPath(cursor.target)),
      );
    }
  } finally {
    driver.close();
  }
}
