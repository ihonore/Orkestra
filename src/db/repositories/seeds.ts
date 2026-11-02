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
  /**
   * Applied when the row is first inserted, never on update: re-importing a
   * sheet must not quietly resume a city someone paused on purpose.
   */
  readonly active?: boolean;
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
  /** Applied on first insert only. See {@link CityInput.active}. */
  readonly active?: boolean;
}

export interface UpsertResult {
  readonly inserted: number;
  readonly updated: number;
}

const CITY_COLUMNS = `id, zip, city, state, state_code, county, county_fips, lat, lng,
  population, active, legacy_status, source`;

const CATEGORY_COLUMNS = `id, name, slug, aliases, weight, active, legacy_status`;

function cityParams(c: CityInput, now: Timestamp): Record<string, string | number | null> {
  return {
    zip: c.zip,
    city: c.city,
    state: c.state,
    stateCode: c.stateCode,
    county: c.county ?? null,
    countyFips: c.countyFips ?? null,
    lat: c.lat,
    lng: c.lng,
    population: c.population ?? null,
    now,
  };
}

function categoryParams(c: CategoryInput, now: Timestamp): Record<string, string | number | null> {
  return {
    name: c.name,
    slug: c.slug,
    aliases: c.aliases && c.aliases.length > 0 ? JSON.stringify(c.aliases) : null,
    weight: c.weight ?? 1.0,
    now,
  };
}

export class CitiesRepository extends BaseRepository {
  readonly #upsert: PreparedStatement;

  constructor(driver: SqliteDriver) {
    super(driver);
    this.#upsert = driver.prepare(
      `INSERT INTO cities (zip, city, state, state_code, county, county_fips, lat, lng,
                           population, active, legacy_status, source, created_at, updated_at)
       VALUES (:zip, :city, :state, :stateCode, :county, :countyFips, :lat, :lng,
               :population, :active, :legacyStatus, :source, :now, :now)
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
          active: c.active === false ? 0 : 1,
          legacyStatus: c.legacyStatus ?? null,
          source: c.source ?? null,
          now,
        });
      }
      const inserted = this.count(false) - before;
      return { inserted, updated: cities.length - inserted };
    });
  }

  /**
   * Add one city. Unlike {@link upsertMany} a zip that already exists is an
   * error rather than an overwrite: someone typing a city into a form means
   * "a new one", and silently replacing another row would lose it.
   */
  insert(city: CityInput, now: Timestamp = Date.now()): number {
    const result = this.driver
      .prepare(
        `INSERT INTO cities (zip, city, state, state_code, county, county_fips, lat, lng,
                             population, source, created_at, updated_at)
         VALUES (:zip, :city, :state, :stateCode, :county, :countyFips, :lat, :lng,
                 :population, :source, :now, :now)`,
      )
      .run({ ...cityParams(city, now), source: city.source ?? null });
    return Number(result.lastInsertRowid);
  }

  /** Replace a city's fields in place. The id — and so every job key — is kept. */
  update(id: number, city: CityInput, now: Timestamp = Date.now()): boolean {
    return (
      this.driver
        .prepare(
          `UPDATE cities
              SET zip = :zip, city = :city, state = :state, state_code = :stateCode,
                  county = :county, county_fips = :countyFips, lat = :lat, lng = :lng,
                  population = :population, updated_at = :now
            WHERE id = :id`,
        )
        .run({ ...cityParams(city, now), id }).changes > 0
    );
  }

  setActive(id: number, active: boolean, now: Timestamp = Date.now()): boolean {
    return (
      this.driver
        .prepare(`UPDATE cities SET active = ?, updated_at = ? WHERE id = ?`)
        .run([active ? 1 : 0, now, id]).changes > 0
    );
  }

  delete(id: number): boolean {
    return this.driver.prepare(`DELETE FROM cities WHERE id = ?`).run([id]).changes > 0;
  }

  byId(id: number): CityRecord | null {
    return (
      this.driver
        .prepare<CityRecord>(`SELECT ${CITY_COLUMNS} FROM cities WHERE id = ?`)
        .get([id]) ?? null
    );
  }

  byZip(zip: string): CityRecord | null {
    return (
      this.driver
        .prepare<CityRecord>(`SELECT ${CITY_COLUMNS} FROM cities WHERE zip = ?`)
        .get([zip]) ?? null
    );
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
      `INSERT INTO categories (name, slug, aliases, weight, active, legacy_status,
                               created_at, updated_at)
       VALUES (:name, :slug, :aliases, :weight, :active, :legacyStatus, :now, :now)
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
          active: c.active === false ? 0 : 1,
          legacyStatus: c.legacyStatus ?? null,
          now,
        });
      }
      const inserted = this.count(false) - before;
      return { inserted, updated: categories.length - inserted };
    });
  }

  /** Add one category. A slug that already exists is an error, as for cities. */
  insert(category: CategoryInput, now: Timestamp = Date.now()): number {
    const result = this.driver
      .prepare(
        `INSERT INTO categories (name, slug, aliases, weight, created_at, updated_at)
         VALUES (:name, :slug, :aliases, :weight, :now, :now)`,
      )
      .run(categoryParams(category, now));
    return Number(result.lastInsertRowid);
  }

  /** Replace a category's fields in place, keeping its id. */
  update(id: number, category: CategoryInput, now: Timestamp = Date.now()): boolean {
    return (
      this.driver
        .prepare(
          `UPDATE categories
              SET name = :name, slug = :slug, aliases = :aliases, weight = :weight,
                  updated_at = :now
            WHERE id = :id`,
        )
        .run({ ...categoryParams(category, now), id }).changes > 0
    );
  }

  setActive(id: number, active: boolean, now: Timestamp = Date.now()): boolean {
    return (
      this.driver
        .prepare(`UPDATE categories SET active = ?, updated_at = ? WHERE id = ?`)
        .run([active ? 1 : 0, now, id]).changes > 0
    );
  }

  delete(id: number): boolean {
    return this.driver.prepare(`DELETE FROM categories WHERE id = ?`).run([id]).changes > 0;
  }

  byId(id: number): CategoryRecord | null {
    return (
      this.driver
        .prepare<CategoryRecord>(`SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`)
        .get([id]) ?? null
    );
  }

  bySlug(slug: string): CategoryRecord | null {
    return (
      this.driver
        .prepare<CategoryRecord>(`SELECT ${CATEGORY_COLUMNS} FROM categories WHERE slug = ?`)
        .get([slug]) ?? null
    );
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
