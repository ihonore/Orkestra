/**
 * Spreadsheet reading.
 *
 * `read-excel-file` was chosen over the more obvious candidates on supply-chain
 * grounds: SheetJS's npm build (`xlsx`) is frozen at 0.18.5 and carries two HIGH
 * advisories with no fix available, because upstream moved distribution off npm
 * — and `node-xlsx` just wraps it. `exceljs` pulls 96 transitive packages and
 * currently reports moderate advisories. This one is 6 packages, zero
 * advisories, and actively maintained.
 *
 * Note the 9.x API: the default export returns *all* sheets; `readSheet` selects
 * one. Passing `{ sheet }` to the default export silently returns everything,
 * which is an easy and quiet mistake.
 */
import fs from 'node:fs';
import readWorkbook, { readSheet } from 'read-excel-file/node';
import { ImportError } from '../core/errors/taxonomy.js';
import { displayPath } from '../core/util/paths.js';

/** A spreadsheet cell as delivered by the reader. */
export type Cell = string | number | boolean | Date | null;
export type SheetRows = Cell[][];

export interface ReadSheetOptions {
  /** Sheet name or 1-based index. Defaults to the first sheet. */
  readonly sheet?: string | number;
}

/**
 * Read one sheet as rows of cells, including the header row.
 *
 * CSV is accepted too, so seed data need not be a spreadsheet.
 */
export async function readSpreadsheet(
  file: string,
  options: ReadSheetOptions = {},
): Promise<SheetRows> {
  if (!fs.existsSync(file)) {
    throw new ImportError(`Spreadsheet not found: ${displayPath(file)}`, {
      code: 'IMPORT_FILE_MISSING',
      hint: 'Pass the path to the .xlsx (or .csv) file holding the seed data.',
    });
  }

  if (file.toLowerCase().endsWith('.csv')) {
    return readCsv(file);
  }

  try {
    const rows = (await readSheet(file, options.sheet ?? 1)) as SheetRows;
    return rows;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/sheet/i.test(message) && options.sheet !== undefined) {
      throw new ImportError(
        `Sheet ${JSON.stringify(options.sheet)} not found in ${displayPath(file)}.`,
        {
          code: 'IMPORT_SHEET_MISSING',
          hint: `Available sheets can be listed with: gms import sheets ${displayPath(file)}`,
          cause,
        },
      );
    }
    throw new ImportError(`Could not read ${displayPath(file)}: ${message}`, {
      code: 'IMPORT_READ_FAILED',
      cause,
    });
  }
}

/**
 * Names of every sheet in a workbook, in workbook order.
 *
 * The 9.x default export is the only way to enumerate sheets — there is no
 * `readSheetNames`. It parses every sheet to do it, which is wasteful but this
 * only runs for the `import sheets` diagnostic.
 */
export async function sheetNames(file: string): Promise<string[]> {
  const workbook = await readWorkbook(file);
  return workbook.map((sheet) => sheet.sheet);
}

/**
 * Minimal RFC 4180 CSV reader.
 *
 * Deliberately hand-rolled rather than another dependency: seed CSVs are small
 * and the only subtleties that matter are quoted fields containing commas,
 * escaped quotes, and CRLF.
 */
export function readCsv(file: string): SheetRows {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows: SheetRows = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    row.push(field === '' ? null : field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * Map header names to column indices, case- and whitespace-insensitively.
 *
 * Header text is what users retype and get subtly wrong, so matching is lenient
 * about case, surrounding space and internal runs of space.
 */
export function headerIndex(header: readonly Cell[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((cell, i) => {
    if (cell === null || cell === undefined) return;
    const key = String(cell).trim().toLowerCase().replace(/\s+/g, ' ');
    if (key !== '' && !index.has(key)) index.set(key, i);
  });
  return index;
}

/** Look up a column by any of several accepted header spellings. */
export function column(index: Map<string, number>, ...names: readonly string[]): number | null {
  for (const name of names) {
    const found = index.get(name.trim().toLowerCase().replace(/\s+/g, ' '));
    if (found !== undefined) return found;
  }
  return null;
}
