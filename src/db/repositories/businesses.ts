/**
 * Businesses, sightings and domains.
 *
 * The upsert here is the answer to the legacy system's central defect: 50
 * byte-identical rows and 107 duplicate names, because there was no stable key
 * and no separation between "a business" and "a time we saw it".
 *
 * Two tables, two jobs:
 *  - `businesses` holds one row per real business, keyed on CID (or a hash when
 *    Google gives no CID).
 *  - `business_sightings` records each time one was seen, and under which search.
 *
 * That split is what lets the same plumber found under "Plumber" and "Emergency
 * Plumber" in two adjacent towns be one row with four sightings, rather than
 * four rows.
 */
import type { PreparedStatement, SqliteDriver } from '../driver/types.js';
import { BaseRepository, type Timestamp } from './types.js';

export interface BusinessInput {
  readonly cid: string | null;
  readonly fid: string | null;
  readonly placeId: string | null;
  readonly dedupHash: string;
  readonly name: string;
  readonly categoryPrimary: string | null;
  readonly categoriesJson: string | null;
  readonly rating: number | null;
  readonly reviewsCount: number | null;
  readonly phoneRaw: string | null;
  readonly phoneE164: string | null;
  readonly addressRaw: string | null;
  readonly street: string | null;
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly plusCode: string | null;
  readonly websiteRaw: string | null;
  readonly websiteUrl: string | null;
  readonly domainId: number | null;
  readonly gmapsUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly hoursJson: string | null;
  readonly permanentlyClosed: boolean;
  readonly extractionSource: string | null;
  readonly rawJson: string | null;
  readonly automationId: string;
  readonly runId: string;
}

export interface SightingInput {
  readonly businessId: number;
  readonly jobId: number;
  readonly runId: string;
  readonly seedCityId: number | null;
  readonly seedCategoryId: number | null;
  readonly searchQuery: string;
  readonly rankInResults: number | null;
}

export interface UpsertOutcome {
  readonly id: number;
  /** True when this row did not exist before. Drives the run summary. */
  readonly created: boolean;
}

export interface BusinessRecord {
  readonly id: number;
  readonly cid: string | null;
  readonly name: string;
  readonly website_url: string | null;
  readonly domain_id: number | null;
  readonly phone_e164: string | null;
  readonly city: string | null;
  readonly state_code: string | null;
}

export class BusinessesRepository extends BaseRepository {
  readonly #findByDedup: PreparedStatement<{ id: number }>;
  readonly #findByCid: PreparedStatement<{ id: number }>;
  readonly #insert: PreparedStatement<{ id: number }>;
  readonly #update: PreparedStatement;
  readonly #insertSighting: PreparedStatement;
  readonly #upsertDomain: PreparedStatement<{ id: number }>;

  constructor(driver: SqliteDriver) {
    super(driver);

    this.#findByDedup = driver.prepare<{ id: number }>(
      `SELECT id FROM businesses WHERE dedup_hash = ?`,
    );
    this.#findByCid = driver.prepare<{ id: number }>(`SELECT id FROM businesses WHERE cid = ?`);

    this.#insert = driver.prepare<{ id: number }>(
      `INSERT INTO businesses (
         cid, fid, place_id, dedup_hash, name, category_primary, categories_json,
         rating, reviews_count, phone_raw, phone_e164, address_raw, street, city,
         state_code, postal_code, country, lat, lng, plus_code, website_raw,
         website_url, domain_id, gmaps_url, thumbnail_url, hours_json,
         permanently_closed, extraction_source, raw_json, automation_id,
         first_seen_at, last_seen_at, first_run_id, last_run_id
       ) VALUES (
         :cid, :fid, :placeId, :dedupHash, :name, :categoryPrimary, :categoriesJson,
         :rating, :reviewsCount, :phoneRaw, :phoneE164, :addressRaw, :street, :city,
         :stateCode, :postalCode, :country, :lat, :lng, :plusCode, :websiteRaw,
         :websiteUrl, :domainId, :gmapsUrl, :thumbnailUrl, :hoursJson,
         :permanentlyClosed, :extractionSource, :rawJson, :automationId,
         :now, :now, :runId, :runId
       )
       RETURNING id`,
    );

    // COALESCE on every optional field: a later sighting that happens to be
    // thinner (a listing card rather than a full panel) must not erase detail an
    // earlier one supplied. Only genuinely new information overwrites.
    this.#update = driver.prepare(
      `UPDATE businesses SET
         cid = COALESCE(:cid, cid),
         fid = COALESCE(:fid, fid),
         place_id = COALESCE(:placeId, place_id),
         name = COALESCE(:name, name),
         category_primary = COALESCE(:categoryPrimary, category_primary),
         categories_json = COALESCE(:categoriesJson, categories_json),
         rating = COALESCE(:rating, rating),
         reviews_count = COALESCE(:reviewsCount, reviews_count),
         phone_raw = COALESCE(:phoneRaw, phone_raw),
         phone_e164 = COALESCE(:phoneE164, phone_e164),
         address_raw = COALESCE(:addressRaw, address_raw),
         street = COALESCE(:street, street),
         city = COALESCE(:city, city),
         state_code = COALESCE(:stateCode, state_code),
         postal_code = COALESCE(:postalCode, postal_code),
         country = COALESCE(:country, country),
         lat = COALESCE(:lat, lat),
         lng = COALESCE(:lng, lng),
         plus_code = COALESCE(:plusCode, plus_code),
         website_raw = COALESCE(:websiteRaw, website_raw),
         website_url = COALESCE(:websiteUrl, website_url),
         domain_id = COALESCE(:domainId, domain_id),
         gmaps_url = COALESCE(:gmapsUrl, gmaps_url),
         thumbnail_url = COALESCE(:thumbnailUrl, thumbnail_url),
         hours_json = COALESCE(:hoursJson, hours_json),
         -- Not COALESCEd: a business that reopened must be able to go back to 0.
         permanently_closed = :permanentlyClosed,
         extraction_source = COALESCE(:extractionSource, extraction_source),
         raw_json = COALESCE(:rawJson, raw_json),
         last_seen_at = :now,
         last_run_id = :runId
       WHERE id = :id`,
    );

    // One sighting per (business, job). Re-running a job after a crash updates
    // rather than duplicating, which is what makes resume idempotent.
    this.#insertSighting = driver.prepare(
      `INSERT INTO business_sightings (
         business_id, job_id, run_id, seed_city_id, seed_category_id,
         search_query, rank_in_results, seen_at
       ) VALUES (
         :businessId, :jobId, :runId, :seedCityId, :seedCategoryId,
         :searchQuery, :rankInResults, :now
       )
       ON CONFLICT (business_id, job_id) DO UPDATE SET
         rank_in_results = COALESCE(:rankInResults, rank_in_results),
         seen_at = :now`,
    );

    this.#upsertDomain = driver.prepare<{ id: number }>(
      `INSERT INTO domains (domain, is_social, status, created_at)
       VALUES (:domain, :isSocial, :status, :now)
       ON CONFLICT (domain) DO UPDATE SET domain = domain
       RETURNING id`,
    );
  }

  /**
   * Insert or update a business, matching on CID first and dedup hash second.
   *
   * CID takes precedence because it is authoritative: a business whose name or
   * phone changed still has the same CID, and matching on the hash alone would
   * create a second row for it.
   */
  upsert(input: BusinessInput, now: Timestamp = Date.now()): UpsertOutcome {
    const params = {
      cid: input.cid,
      fid: input.fid,
      placeId: input.placeId,
      dedupHash: input.dedupHash,
      name: input.name,
      categoryPrimary: input.categoryPrimary,
      categoriesJson: input.categoriesJson,
      rating: input.rating,
      reviewsCount: input.reviewsCount,
      phoneRaw: input.phoneRaw,
      phoneE164: input.phoneE164,
      addressRaw: input.addressRaw,
      street: input.street,
      city: input.city,
      stateCode: input.stateCode,
      postalCode: input.postalCode,
      country: input.country,
      lat: input.lat,
      lng: input.lng,
      plusCode: input.plusCode,
      websiteRaw: input.websiteRaw,
      websiteUrl: input.websiteUrl,
      domainId: input.domainId,
      gmapsUrl: input.gmapsUrl,
      thumbnailUrl: input.thumbnailUrl,
      hoursJson: input.hoursJson,
      permanentlyClosed: input.permanentlyClosed ? 1 : 0,
      extractionSource: input.extractionSource,
      rawJson: input.rawJson,
      automationId: input.automationId,
      runId: input.runId,
      now,
    };

    const existing =
      (input.cid !== null ? this.#findByCid.get([input.cid]) : undefined) ??
      this.#findByDedup.get([input.dedupHash]);

    if (existing !== undefined) {
      this.#update.run({ ...params, id: existing.id });
      return { id: existing.id, created: false };
    }

    const inserted = this.#insert.get(params);
    if (inserted === undefined) {
      throw new Error(`insert of business ${input.name} returned no row`);
    }
    return { id: inserted.id, created: true };
  }

  recordSighting(input: SightingInput, now: Timestamp = Date.now()): void {
    this.#insertSighting.run({
      businessId: input.businessId,
      jobId: input.jobId,
      runId: input.runId,
      seedCityId: input.seedCityId,
      seedCategoryId: input.seedCategoryId,
      searchQuery: input.searchQuery,
      rankInResults: input.rankInResults,
      now,
    });
  }

  /**
   * Get or create the row for a registrable domain.
   *
   * Deduplicated globally, so a franchise's shared website becomes exactly one
   * crawl job no matter how many of its locations reference it.
   */
  upsertDomain(domain: string, isSocial: boolean, now: Timestamp = Date.now()): number {
    const row = this.#upsertDomain.get({
      domain,
      isSocial: isSocial ? 1 : 0,
      // A social profile is never crawled for a business email, so it starts
      // life already skipped rather than being queued and rejected later.
      status: isSocial ? 'skipped' : 'pending',
      now,
    });
    if (row === undefined) throw new Error(`domain upsert returned no row for ${domain}`);
    return row.id;
  }

  byId(id: number): BusinessRecord | null {
    return (
      this.driver
        .prepare<BusinessRecord>(
          `SELECT id, cid, name, website_url, domain_id, phone_e164, city, state_code
             FROM businesses WHERE id = ?`,
        )
        .get([id]) ?? null
    );
  }

  count(): number {
    return this.driver.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM businesses`).get()?.n ?? 0;
  }

  sightingCount(): number {
    return (
      this.driver.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM business_sightings`).get()?.n ??
      0
    );
  }

  /** Per-field fill counts across all stored businesses, for the run summary. */
  fillStats(): Record<string, number> {
    const row = this.driver
      .prepare<Record<string, number>>(
        `SELECT COUNT(*) AS total,
                COUNT(cid) AS cid,
                COUNT(name) AS name,
                COUNT(phone_e164) AS phone,
                COUNT(address_raw) AS address,
                COUNT(website_url) AS website,
                COUNT(rating) AS rating,
                COUNT(domain_id) AS domain
           FROM businesses`,
      )
      .get();
    return row ?? {};
  }
}
