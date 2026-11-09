/**
 * `gms seeds` — the city and service lists committed in `seeds/`.
 *
 * `load` brings a database up to date with the files; `save` writes the
 * database's lists back to them, so edits made in the dashboard can be
 * committed and reach another machine with `git pull`.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { displayPath } from '../../core/util/paths.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { loadBundledSeeds, saveSeedFiles } from '../../seeds/bundled.js';
import { heading, keyValue, style, symbol } from '../output.js';

export interface SeedsCommandOptions {
  readonly config: ResolvedConfig;
  readonly json?: boolean;
}

export function runSeedsLoad(options: SeedsCommandOptions): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const dir = options.config.paths.seedsDir;
    const result = loadBundledSeeds(driver, { dir });
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.cities === null && result.categories === null) {
      console.log(`${symbol.warn} no seed files in ${displayPath(dir)}`);
      return;
    }

    const rows: [string, string][] = [];
    if (result.cities !== null) {
      const r = result.cities.result;
      rows.push(['cities', `${r.inserted} added, ${r.updated} already present`]);
    }
    if (result.categories !== null) {
      const r = result.categories.result;
      rows.push(['services', `${r.inserted} added, ${r.updated} already present`]);
    }
    if (result.jobsUpdated > 0) rows.push(['queued jobs refreshed', String(result.jobsUpdated)]);
    console.log(keyValue(rows));

    const rejected = [...(result.cities?.rejected ?? []), ...(result.categories?.rejected ?? [])];
    if (rejected.length > 0) {
      console.log(heading(`Skipped ${rejected.length} row(s)`));
      for (const r of rejected.slice(0, 10)) {
        console.log(`  ${style.yellow(`row ${r.row}`.padEnd(12))} ${r.reason}`);
      }
    }
    console.log(
      style.grey(
        '\nRows are matched by zip and service name. Nothing is deleted, and paused rows stay paused.',
      ),
    );
  } finally {
    driver.close();
  }
}

export function runSeedsSave(options: SeedsCommandOptions): void {
  const driver = openDatabaseFromConfig(options.config, { readonly: true });
  try {
    const result = saveSeedFiles(driver, options.config.paths.seedsDir);
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${symbol.ok} wrote ${result.cities} cities and ${result.categories} services to ${displayPath(result.dir)}`,
    );
    console.log(
      style.grey(`\nCommit ${displayPath(result.dir)} so a fresh install starts from these lists.`),
    );
  } finally {
    driver.close();
  }
}
