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
import {
  VIEWS,
  countRemaining,
  readPage,
  type ExportCursor,
  type ExportRow,
  sharedLeadEntity,
  startingCursor,
} from '../../views/index.js';
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

    const start = cursors.cursor('csv', target, entity);
    const pending = countRemaining(driver, schema, start);
    const writers = new Map<string, CsvWriter>();
    // Flag if given, config otherwise. Both keys ship in the starter config and
    // were previously read by nothing at all, so a project that set
    // `exporters.csv.bom: false` still got a byte-order mark.
    const csvSettings = options.config.exporters.csv;
    const csvOptions = {
      excelSafeText: options.excelSafe ?? csvSettings.excelSafeText,
      bom: options.bom ?? csvSettings.bom,
      newline: options.crlf === true ? ('\r\n' as const) : ('\n' as const),
      // --full starts the cursor over, so the file must start over too.
      replace: options.full === true,
    };

    let cursor = start;
    let written = 0;

    for (;;) {
      const page = readPage(driver, schema, cursor, PAGE_SIZE);
      const rows = page.rows;
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

      cursor = page.next;

      // Advance only after the rows are on disk. A crash here re-exports this
      // page next time, which is far better than skipping it.
      cursors.advance('csv', target, entity, cursor, rows.length);

      if (page.done) break;
    }

    // A view with two streams pages until both are drained, so "fewer rows than
    // asked for" no longer means "finished". Checking written against the count
    // taken up front turns any future paging mistake into a loud failure rather
    // than a quietly short export.
    if (written !== pending) {
      throw new AppError(
        `Exported ${written.toLocaleString()} row(s) but ${pending.toLocaleString()} were pending.`,
        {
          code: 'EXPORT_INCOMPLETE',
          hint: 'The rows are safe in the database — the cursor is what is wrong. Please report this.',
        },
      );
    }

    const files = [...writers.keys()].map((file) => ({
      file,
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    }));

    if (options.json === true) {
      console.log(JSON.stringify({ entity, written, cursor, files }, null, 2));
      return;
    }

    if (written === 0) {
      console.log(
        style.grey(
          start.lastId > 0 || start.lastSubId > 0
            ? 'Nothing new to export — everything is already written. Use --full to re-export.'
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
        ['cursor', describeCursor(start, cursor)],
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
    const toCursor = (row: { last_id: number; last_sub_id: number } | null) =>
      row === null ? null : { lastId: row.last_id, lastSubId: row.last_sub_id };
    const partner = sharedLeadEntity(entity);
    const start = startingCursor(
      entity,
      toCursor(cursors.position('sheets', spreadsheetId, entity)),
      // --full means "send everything again", so it must not skip ahead.
      partner === null || options.full === true
        ? null
        : toCursor(cursors.position('sheets', spreadsheetId, partner)),
    );

    const exporter = new SheetsExporter({
      spreadsheetId,
      sheetName,
      createIfMissing: settings.createIfMissing,
      ...(settings.credentialsFile !== undefined && {
        credentialsFile: resolvePath(settings.credentialsFile, options.config.paths.root),
      }),
    });

    const room = await exporter.prepare(schema);
    const pending = countRemaining(driver, schema, start);

    if (pending === 0) {
      console.log(
        style.grey(
          start.lastId > 0 || start.lastSubId > 0
            ? 'Nothing new — the sheet already has every row.'
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

    let cursor = start;
    let written = 0;
    let requests = 0;
    let retries = 0;

    for (;;) {
      const page = readPage(driver, schema, cursor, PAGE_SIZE);
      const rows = page.rows;
      if (rows.length === 0) break;

      const result = await exporter.append(rows, schema);
      written += result.appended;
      requests += result.requests;
      retries += result.retries;

      cursor = page.next;
      // Only after Sheets confirmed the write.
      cursors.advance('sheets', spreadsheetId, entity, cursor, rows.length);

      if (page.done) break;
    }

    if (written !== pending) {
      throw new AppError(
        `Sent ${written.toLocaleString()} row(s) but ${pending.toLocaleString()} were pending.`,
        {
          code: 'EXPORT_INCOMPLETE',
          hint:
            'The rows are safe in the database and the sheet has what was sent.\n' +
            'Re-running is safe; if the count is still short, please report this.',
        },
      );
    }

    if (options.json === true) {
      console.log(JSON.stringify({ entity, written, requests, retries, cursor }, null, 2));
      return;
    }

    console.log(heading('Sent'));
    console.log(
      keyValue([
        ['rows', written.toLocaleString()],
        ['api requests', String(requests)],
        ['retries', String(retries)],
        ['cursor', describeCursor(start, cursor)],
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

/** Human-readable "where we were -> where we are", hiding the sub-cursor when unused. */
function describeCursor(from: ExportCursor, to: ExportCursor): string {
  const show = (c: ExportCursor): string =>
    c.lastSubId > 0 || from.lastSubId > 0 ? `${c.lastId}/${c.lastSubId}` : String(c.lastId);
  return `${show(from)} -> ${show(to)}`;
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
      // leads-flat has a second watermark; show it only where it is used, so
      // the common single-cursor case stays readable.
      const at =
        cursor.last_sub_id > 0 ? `${cursor.last_id}/${cursor.last_sub_id}` : String(cursor.last_id);
      console.log(
        `  ${style.bold(cursor.exporter.padEnd(8))} ${cursor.entity.padEnd(12)} ` +
          `at ${at.padStart(10)}  ${String(cursor.rows_total).padStart(8)} rows  ` +
          style.grey(displayPath(cursor.target)),
      );
    }
  } finally {
    driver.close();
  }
}
