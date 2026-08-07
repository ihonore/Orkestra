/**
 * Seed data: the cities and categories that job planning is a cross product of.
 *
 * Both repositories upsert on a natural key (zip for cities, slug for
 * categories) so re-importing a corrected spreadsheet updates rows in place
 * rather than duplicating them — and, importantly, without disturbing the `id`
 * values that existing jobs reference by `task_key`.
 */
import type { PreparedStatement, SqliteDriver } from '../driver/types.js';
import { BaseRepository, type Timestamp } from './types.js';

export interface CityRecord {
  readonly id: number;
  readonly zip: string;
  readonly city: string;
  readonly state: string;
  readonly state_code: string;
  readonly county: string | null;
  readonly county_fips: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly population: number | null;
  readonly active: number;
  readonly legacy_status: string | null;
  readonly source: string | null;
}

export interface CityInput {
  readonly zip: string;
  readonly city: string;
  readonly state: string;
  readonly stateCode: string;
  readonly county?: string | null;
  readonly countyFips?: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly population?: number | null;
  readonly legacyStatus?: string | null;
  readonly source?: string | null;
}

export interface CategoryRecord {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly aliases: string | null;
  readonly weight: number;
  readonly active: number;
  readonly legacy_status: string | null;
}

export interface CategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly aliases?: readonly string[] | null;
  readonly weight?: number;
  readonly legacyStatus?: string | null;
}

export interface UpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

const CITY_COLUMNS = `id, zip, city, state, state_code, county, county_fips, lat, lng,
  population, active, legacy_status, source`;

const CATEGORY_COLUMNS = `id, name, slug, aliases, weight, active, legacy_status`;

export class CitiesRepository extends BaseRepository {
  readonly #upsert: PreparedStatement;

  constructor(driver: SqliteDriver) {
    super(driver);
    this.#upsert = driver.prepare(
      `INSERT INTO cities (zip, city, state, state_code, county, county_fips, lat, lng,
                           population, legacy_status, source, created_at, updated_at)
       VALUES (:zip, :city, :state, :stateCode, :county, :countyFips, :lat, :lng,
               :population, :legacyStatus, :source, :now, :now)
       ON CONFLICT (zip) DO UPDATE SET
         city = :city, state = :state, state_code = :stateCode, county = :county,
         county_fips = :countyFips, lat = :lat, lng = :lng,
         population = COALESCE(:population, cities.population),
         legacy_status = :legacyStatus, source = :source, updated_at = :now`,
    );
  }

  /**
   * Insert or update by zip. Existing `id` values are preserved, so jobs that
   * reference a city by id survive a re-import of corrected seed data.
   *
   * Insert-vs-update is counted by row-count delta rather than by comparing
   * timestamps: two imports inside the same millisecond would make a
   * `created_at = :now` test report updates as inserts.
   */
  upsertMany(cities: readonly CityInput[], now: Timestamp = Date.now()): UpsertResult {
    return this.inTransaction(() => {
      const before = this.count(false);
      for (const c of cities) {
        this.#upsert.run({
          zip: c.zip,
          city: c.city,
          state: c.state,
          stateCode: c.stateCode,
          county: c.county ?? null,
          countyFips: c.countyFips ?? null,
          lat: c.lat,
          lng: c.lng,
          population: c.population ?? null,
          legacyStatus: c.legacyStatus ?? null,
          source: c.source ?? null,
          now,
        });
      }
      const inserted = this.count(false) - before;
      return { inserted, updated: cities.length - inserted };
    });
  }

  all(activeOnly = true): CityRecord[] {
    return this.driver
      .prepare<CityRecord>(
        `SELECT ${CITY_COLUMNS} FROM cities ${activeOnly ? 'WHERE active = 1' : ''}
          ORDER BY state_code, city`,
      )
      .all();
  }

  count(activeOnly = true): number {
    return (
      this.driver
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM cities ${activeOnly ? 'WHERE active = 1' : ''}`,
        )
        .get()?.n ?? 0
    );
  }

  /**
   * Resolve user-supplied selectors to cities.
   *
   * A selector matches a city name, a zip, or a state code, case-insensitively,
   * so `--cities Atlanta,30301,AL` all work and can be mixed.
   */
  findBySelectors(selectors: readonly string[], activeOnly = true): CityRecord[] {
    if (selectors.length === 0) return this.all(activeOnly);

    const placeholders = selectors.map(() => '?').join(', ');
    const normalized = selectors.map((s) => s.trim().toLowerCase());
    return this.driver
      .prepare<CityRecord>(
        `SELECT ${CITY_COLUMNS} FROM cities
          WHERE (LOWER(city) IN (${placeholders})
                 OR zip IN (${placeholders})
                 OR LOWER(state_code) IN (${placeholders}))
            ${activeOnly ? 'AND active = 1' : ''}
          ORDER BY state_code, city`,
      )
      .all([...normalized, ...normalized, ...normalized]);
  }
}

export class CategoriesRepository extends BaseRepository {
  readonly #upsert: PreparedStatement;

  constructor(driver: SqliteDriver) {
    super(driver);
    this.#upsert = driver.prepare(
      `INSERT INTO categories (name, slug, aliases, weight, legacy_status, created_at, updated_at)
       VALUES (:name, :slug, :aliases, :weight, :legacyStatus, :now, :now)
       ON CONFLICT (slug) DO UPDATE SET
         name = :name, aliases = :aliases, weight = :weight,
         legacy_status = :legacyStatus, updated_at = :now`,
    );
  }

  /** Insert or update by slug, preserving existing ids. See {@link CitiesRepository.upsertMany}. */
  upsertMany(categories: readonly CategoryInput[], now: Timestamp = Date.now()): UpsertResult {
    return this.inTransaction(() => {
      const before = this.count(false);
      for (const c of categories) {
        this.#upsert.run({
          name: c.name,
          slug: c.slug,
          aliases: c.aliases ? JSON.stringify(c.aliases) : null,
          weight: c.weight ?? 1.0,
          legacyStatus: c.legacyStatus ?? null,
          now,
        });
      }
      const inserted = this.count(false) - before;
      return { inserted, updated: categories.length - inserted };
    });
  }

  all(activeOnly = true): CategoryRecord[] {
    return this.driver
      .prepare<CategoryRecord>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories ${activeOnly ? 'WHERE active = 1' : ''}
          ORDER BY name`,
      )
      .all();
  }

  count(activeOnly = true): number {
    return (
      this.driver
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM categories ${activeOnly ? 'WHERE active = 1' : ''}`,
        )
        .get()?.n ?? 0
    );
  }

  /** Resolve selectors against category name or slug, case-insensitively. */
  findBySelectors(selectors: readonly string[], activeOnly = true): CategoryRecord[] {
    if (selectors.length === 0) return this.all(activeOnly);

    const placeholders = selectors.map(() => '?').join(', ');
    const normalized = selectors.map((s) => s.trim().toLowerCase());
    return this.driver
      .prepare<CategoryRecord>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories
          WHERE (LOWER(name) IN (${placeholders}) OR slug IN (${placeholders}))
            ${activeOnly ? 'AND active = 1' : ''}
          ORDER BY name`,
      )
      .all([...normalized, ...normalized]);
  }
}
