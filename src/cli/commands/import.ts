/**
 * `gms import` — load seed data.
 *
 * Repairs and rejections are always reported. Silence here is dangerous: a seed
 * import that drops rows quietly produces a run that is missing whole states,
 * and nothing downstream looks wrong.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { CategoriesRepository, CitiesRepository } from '../../db/repositories/seeds.js';
import {
  parseCategories,
  parseCities,
  type Repair,
  type RejectedRow,
} from '../../importers/seeds.js';
import { sheetNames } from '../../importers/xlsx.js';
import { refreshAllJobs } from '../../seeds/manage.js';
import { heading, keyValue, style, symbol } from '../output.js';

export interface ImportCommandOptions {
  readonly config: ResolvedConfig;
  readonly file: string;
  readonly sheet?: string | number;
  readonly json?: boolean;
  readonly dryRun?: boolean;
}

function reportRepairs(repairs: readonly Repair[]): void {
  if (repairs.length === 0) return;
  console.log(heading(`Repaired ${repairs.length} value(s)`));
  const byField = new Map<string, Repair[]>();
  for (const r of repairs) {
    const list = byField.get(r.field) ?? [];
    list.push(r);
    byField.set(r.field, list);
  }
  for (const [field, list] of byField) {
    const sample = list
      .slice(0, 5)
      .map((r) => `${r.from}->${r.to}`)
      .join(', ');
    const more = list.length > 5 ? `, +${list.length - 5} more` : '';
    console.log(`  ${style.yellow(field.padEnd(12))} ${list.length} restored leading zeros`);
    console.log(`  ${' '.repeat(12)} ${style.grey(sample + more)}`);
  }
}

function reportRejected(rejected: readonly RejectedRow[]): void {
  if (rejected.length === 0) return;
  console.log(heading(`Skipped ${rejected.length} row(s)`));
  for (const r of rejected.slice(0, 10)) {
    console.log(
      `  ${style.yellow(`row ${r.row}`.padEnd(12))} ${r.reason}${r.value ? style.grey(` (${r.value})`) : ''}`,
    );
  }
  if (rejected.length > 10) console.log(style.grey(`  +${rejected.length - 10} more`));
}

export async function runImportCities(options: ImportCommandOptions): Promise<void> {
  const parsed = await parseCities(options.file, {
    ...(options.sheet !== undefined && { sheet: options.sheet }),
    source: options.file,
  });

  if (options.json === true) {
    console.log(JSON.stringify({ ...parsed, applied: options.dryRun !== true }, null, 2));
    if (options.dryRun === true) return;
  }

  if (options.dryRun === true) {
    if (options.json !== true) {
      console.log(
        keyValue([
          ['rows read', String(parsed.totalRows)],
          ['would import', String(parsed.cities.length)],
          ['repairs', String(parsed.repairs.length)],
          ['skipped', String(parsed.rejected.length)],
        ]),
      );
      reportRepairs(parsed.repairs);
      reportRejected(parsed.rejected);
      console.log(`\n${style.grey('Dry run — nothing was written.')}`);
    }
    return;
  }

  const driver = openDatabaseFromConfig(options.config);
  try {
    const result = new CitiesRepository(driver).upsertMany(parsed.cities);
    // A corrected row must reach the searches already queued for it, not only
    // the ones planned from now on.
    const refreshed = result.updated > 0 ? refreshAllJobs(driver) : 0;
    if (options.json === true) return;

    console.log(
      keyValue([
        ['rows read', String(parsed.totalRows)],
        ['inserted', String(result.inserted)],
        ['updated', String(result.updated)],
        ['skipped', String(parsed.rejected.length)],
        ...(refreshed > 0 ? [['queued jobs refreshed', String(refreshed)] as const] : []),
      ]),
    );
    reportRepairs(parsed.repairs);
    reportRejected(parsed.rejected);
    console.log(`\n${symbol.ok} ${parsed.cities.length} cities in the database`);
  } finally {
    driver.close();
  }
}

export async function runImportCategories(options: ImportCommandOptions): Promise<void> {
  const parsed = await parseCategories(options.file, {
    ...(options.sheet !== undefined && { sheet: options.sheet }),
  });

  if (options.json === true) {
    console.log(JSON.stringify({ ...parsed, applied: options.dryRun !== true }, null, 2));
    if (options.dryRun === true) return;
  }

  if (options.dryRun === true) {
    if (options.json !== true) {
      console.log(
        keyValue([
          ['rows read', String(parsed.totalRows)],
          ['would import', String(parsed.categories.length)],
          ['skipped', String(parsed.rejected.length)],
        ]),
      );
      reportRejected(parsed.rejected);
      console.log(`\n${style.grey('Dry run — nothing was written.')}`);
    }
    return;
  }

  const driver = openDatabaseFromConfig(options.config);
  try {
    const result = new CategoriesRepository(driver).upsertMany(parsed.categories);
    // A corrected row must reach the searches already queued for it, not only
    // the ones planned from now on.
    const refreshed = result.updated > 0 ? refreshAllJobs(driver) : 0;
    if (options.json === true) return;

    console.log(
      keyValue([
        ['rows read', String(parsed.totalRows)],
        ['inserted', String(result.inserted)],
        ['updated', String(result.updated)],
        ['skipped', String(parsed.rejected.length)],
        ...(refreshed > 0 ? [['queued jobs refreshed', String(refreshed)] as const] : []),
      ]),
    );
    reportRejected(parsed.rejected);
    console.log(`\n${symbol.ok} ${parsed.categories.length} categories in the database`);
  } finally {
    driver.close();
  }
}

/** `gms import sheets <file>` — list the sheets in a workbook. */
export async function runListSheets(file: string): Promise<void> {
  const names = await sheetNames(file);
  console.log(heading('Sheets'));
  for (const name of names) console.log(`  ${name}`);
}
