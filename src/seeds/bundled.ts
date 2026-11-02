/**
 * The starting city and service lists, shipped with the code.
 *
 * `data/` (the database) and `assests/` (the source workbook) are both
 * git-ignored, so neither reaches a fresh checkout. `seeds/` is committed, which
 * makes the lists travel with `git clone` to any machine — the Windows VPS
 * included — and a first `gms db migrate` loads them.
 *
 * Plain CSV, read by the same parser as `gms import`, so the leading-zero
 * repairs and the duplicate checks apply here too. CSV rather than a SQL
 * migration because it is meant to be edited and diffed: `gms seeds save` writes
 * the database's current lists back here, ready to commit.
 *
 * The database stays the source of truth. These files are where a new database
 * starts from, not a mirror that is kept in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { moduleDir } from '../core/util/paths.js';
import type { SqliteDriver } from '../db/driver/types.js';
import { MetaRepository } from '../db/repositories/meta.js';
import {
  CategoriesRepository,
  CitiesRepository,
  type CategoryRecord,
  type CityRecord,
  type UpsertResult,
} from '../db/repositories/seeds.js';
import {
  parseCategoryRows,
  parseCityRows,
  type RejectedRow,
  type Repair,
} from '../importers/seeds.js';
import { readCsv } from '../importers/xlsx.js';
import { refreshAllJobs } from './manage.js';

export const SEED_FILES = { cities: 'cities.csv', categories: 'services.csv' } as const;

/** Set once the first-run load has been considered, whatever it found. */
const LOADED_KEY = 'bundled_seeds_loaded_at';

/**
 * Locate the committed `seeds/` directory, beside `migrations/`.
 *
 * Resolved from this module rather than the working directory, for the same
 * reason as the migrations: `gms` runs from anywhere, under tsx or from dist.
 */
export function bundledSeedsDir(): string {
  // src/seeds/bundled.ts -> ../../seeds ; dist/seeds/bundled.js -> ../../seeds
  return path.resolve(moduleDir(import.meta.url), '..', '..', 'seeds');
}

export interface LoadedFile {
  readonly file: string;
  readonly result: UpsertResult;
  readonly repairs: readonly Repair[];
  readonly rejected: readonly RejectedRow[];
}

export interface LoadResult {
  readonly cities: LoadedFile | null;
  readonly categories: LoadedFile | null;
  /** Unstarted jobs rewritten to match the loaded rows. */
  readonly jobsUpdated: number;
}

export interface LoadOptions {
  readonly dir?: string;
  /** Load a kind only when its table is empty. */
  readonly onlyIfEmpty?: boolean;
}

/**
 * Upsert the bundled lists into the database.
 *
 * Adds missing rows and updates changed ones by natural key (zip, slug). It
 * never deletes, and never changes whether an existing row is paused — a
 * file is a starting point, and must not undo decisions made since.
 */
export function loadBundledSeeds(driver: SqliteDriver, options: LoadOptions = {}): LoadResult {
  const dir = options.dir ?? bundledSeedsDir();
  const cities = new CitiesRepository(driver);
  const categories = new CategoriesRepository(driver);

  const citiesFile = path.join(dir, SEED_FILES.cities);
  const categoriesFile = path.join(dir, SEED_FILES.categories);

  return driver.transaction(() => {
    let loadedCities: LoadedFile | null = null;
    if (fs.existsSync(citiesFile) && !(options.onlyIfEmpty === true && cities.count(false) > 0)) {
      const parsed = parseCityRows(readCsv(citiesFile), `seeds/${SEED_FILES.cities}`);
      loadedCities = {
        file: citiesFile,
        result: cities.upsertMany(parsed.cities),
        repairs: parsed.repairs,
        rejected: parsed.rejected,
      };
    }

    let loadedCategories: LoadedFile | null = null;
    if (
      fs.existsSync(categoriesFile) &&
      !(options.onlyIfEmpty === true && categories.count(false) > 0)
    ) {
      const parsed = parseCategoryRows(readCsv(categoriesFile));
      loadedCategories = {
        file: categoriesFile,
        result: categories.upsertMany(parsed.categories),
        repairs: parsed.repairs,
        rejected: parsed.rejected,
      };
    }

    const changed = loadedCities !== null || loadedCategories !== null;
    return {
      cities: loadedCities,
      categories: loadedCategories,
      jobsUpdated: changed ? refreshAllJobs(driver) : 0,
    };
  }, 'immediate');
}

/**
 * The first-run load, called by `gms db migrate`.
 *
 * Runs once per database. The marker is what stops a deliberate "delete every
 * city" from being undone by the next migrate; the empty-table check is what
 * stops it overwriting a database that already has its own lists.
 */
export function loadBundledSeedsOnce(driver: SqliteDriver, dir?: string): LoadResult | null {
  const meta = new MetaRepository(driver);
  if (meta.get(LOADED_KEY) !== undefined) return null;
  const result = loadBundledSeeds(driver, { onlyIfEmpty: true, ...(dir !== undefined && { dir }) });
  meta.set(LOADED_KEY, String(Date.now()));
  return result.cities === null && result.categories === null ? null : result;
}

/** One CSV field, quoted only when it has to be. */
function field(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: readonly string[], rows: readonly (string | number | null)[][]): string {
  // CRLF and no BOM: what Excel on Windows writes, and what the reader accepts.
  return [header, ...rows].map((row) => row.map(field).join(',')).join('\r\n') + '\r\n';
}

export function citiesCsv(rows: readonly CityRecord[]): string {
  return csv(
    [
      'Zip',
      'City',
      'State',
      'State Code',
      'County',
      'County Code',
      'Latitude',
      'Longitude',
      'Population',
      'Active',
    ],
    rows.map((c) => [
      c.zip,
      c.city,
      c.state,
      c.state_code,
      c.county,
      c.county_fips,
      c.lat,
      c.lng,
      c.population,
      c.active === 1 ? 'yes' : 'no',
    ]),
  );
}

export function categoriesCsv(rows: readonly CategoryRecord[]): string {
  return csv(
    ['Name', 'Weight', 'Aliases', 'Active'],
    rows.map((c) => [
      c.name,
      c.weight,
      c.aliases === null ? null : (JSON.parse(c.aliases) as string[]).join('|'),
      c.active === 1 ? 'yes' : 'no',
    ]),
  );
}

export interface SaveResult {
  readonly dir: string;
  readonly cities: number;
  readonly categories: number;
}

/**
 * Write the database's current lists to `seeds/`, paused rows included.
 *
 * Written to a temporary name and renamed, so an interrupted save cannot leave
 * a half-written file that the next fresh install then loads.
 */
export function saveSeedFiles(driver: SqliteDriver, dir: string = bundledSeedsDir()): SaveResult {
  const cities = new CitiesRepository(driver).all(false);
  const categories = new CategoriesRepository(driver).all(false);
  fs.mkdirSync(dir, { recursive: true });

  const write = (name: string, content: string): void => {
    const target = path.join(dir, name);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, target);
  };
  write(SEED_FILES.cities, citiesCsv(cities));
  write(SEED_FILES.categories, categoriesCsv(categories));

  return { dir, cities: cities.length, categories: categories.length };
}
