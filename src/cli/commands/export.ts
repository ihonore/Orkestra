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
import { displayPath } from '../../core/util/paths.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { ExportsRepository } from '../../db/repositories/exports.js';
import { CsvWriter, groupKeyFor } from '../../exporters/csv.js';
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
