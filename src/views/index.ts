/**
 * Export row shapes.
 *
 * Every exporter reads these, so CSV and Sheets cannot drift into having
 * different columns for the same entity. The `RecordSchema` also declares which
 * fields are *text that looks numeric* — zips, phones, FIPS codes, CIDs — which
 * is the single most important piece of metadata here.
 */
import type { SqliteDriver } from '../db/driver/types.js';

/** How a value must be treated by a destination that guesses types. */
export type FieldKind = 'text' | 'number' | 'boolean' | 'timestamp' | 'digits';

export interface FieldDef {
  readonly name: string;
  readonly kind: FieldKind;
  readonly description?: string;
}

export interface RecordSchema {
  readonly entity: string;
  readonly fields: readonly FieldDef[];
  /** SQL producing the rows, with `id` as the cursor column. */
  readonly sql: string;
}

/**
 * `digits` is a distinct kind from `text` for one reason.
 *
 * A zip of `01234`, a CID of `13019781180686529338`, and a phone of
 * `+12052360125` are all *identifiers made of digits*. Every destination that
 * guesses types will damage them: Excel turns `01234` into `1234`, and anything
 * parsing to a JS number corrupts a 20-digit CID from the 17th digit. Marking
 * them here lets each exporter apply the right protection for its own format.
 */

export const LEADS_FLAT: RecordSchema = {
  entity: 'leads-flat',
  fields: [
    { name: 'business_id', kind: 'number' },
    { name: 'name', kind: 'text' },
    { name: 'category', kind: 'text' },
    { name: 'phone', kind: 'digits', description: 'E.164' },
    { name: 'email', kind: 'text' },
    { name: 'email_type', kind: 'text', description: 'personal | role | free' },
    { name: 'email_confidence', kind: 'number' },
    { name: 'website', kind: 'text' },
    { name: 'domain', kind: 'text' },
    { name: 'street', kind: 'text' },
    { name: 'city', kind: 'text' },
    { name: 'state', kind: 'text' },
    { name: 'zip', kind: 'digits' },
    { name: 'rating', kind: 'number' },
    { name: 'reviews', kind: 'number' },
    { name: 'searched_city', kind: 'text' },
    { name: 'searched_category', kind: 'text' },
    { name: 'gmaps_url', kind: 'text' },
    { name: 'cid', kind: 'digits', description: '64-bit; never a number' },
    { name: 'first_seen', kind: 'timestamp' },
  ],
  // One row per (business, email). A business with three addresses produces
  // three rows, which is what a mail-merge wants. Businesses with no email are
  // included with a blank email column rather than dropped — they are still
  // leads, reachable by phone.
  sql: `
    SELECT
      b.id                                   AS id,
      b.id                                   AS business_id,
      b.name                                 AS name,
      b.category_primary                     AS category,
      b.phone_e164                           AS phone,
      e.address                              AS email,
      CASE WHEN e.address IS NULL THEN NULL
           WHEN e.is_role = 1 THEN 'role'
           WHEN e.is_free = 1 THEN 'free'
           ELSE 'personal' END               AS email_type,
      be.confidence                          AS email_confidence,
      b.website_url                          AS website,
      d.domain                               AS domain,
      b.street                               AS street,
      b.city                                 AS city,
      b.state_code                           AS state,
      b.postal_code                          AS zip,
      b.rating                               AS rating,
      b.reviews_count                        AS reviews,
      seed_city.city                         AS searched_city,
      seed_cat.name                          AS searched_category,
      b.gmaps_url                            AS gmaps_url,
      b.cid                                  AS cid,
      b.first_seen_at                        AS first_seen
    FROM businesses b
    LEFT JOIN business_emails be ON be.business_id = b.id
    LEFT JOIN emails e ON e.id = be.email_id AND e.is_junk = 0
    LEFT JOIN domains d ON d.id = b.domain_id
    LEFT JOIN business_sightings s ON s.id = (
      SELECT id FROM business_sightings WHERE business_id = b.id ORDER BY id LIMIT 1
    )
    LEFT JOIN cities seed_city ON seed_city.id = s.seed_city_id
    LEFT JOIN categories seed_cat ON seed_cat.id = s.seed_category_id
    WHERE b.id > :lastId
    ORDER BY b.id
    LIMIT :limit`,
};

export const BUSINESSES: RecordSchema = {
  entity: 'businesses',
  fields: [
    { name: 'id', kind: 'number' },
    { name: 'cid', kind: 'digits' },
    { name: 'name', kind: 'text' },
    { name: 'category', kind: 'text' },
    { name: 'phone', kind: 'digits' },
    { name: 'website', kind: 'text' },
    { name: 'address', kind: 'text' },
    { name: 'city', kind: 'text' },
    { name: 'state', kind: 'text' },
    { name: 'zip', kind: 'digits' },
    { name: 'lat', kind: 'number' },
    { name: 'lng', kind: 'number' },
    { name: 'rating', kind: 'number' },
    { name: 'reviews', kind: 'number' },
    { name: 'email_count', kind: 'number' },
    { name: 'first_seen', kind: 'timestamp' },
  ],
  sql: `
    SELECT
      b.id AS id, b.cid AS cid, b.name AS name,
      b.category_primary AS category, b.phone_e164 AS phone,
      b.website_url AS website, b.address_raw AS address,
      b.city AS city, b.state_code AS state, b.postal_code AS zip,
      b.lat AS lat, b.lng AS lng, b.rating AS rating, b.reviews_count AS reviews,
      (SELECT COUNT(*) FROM business_emails be
        JOIN emails e ON e.id = be.email_id
        WHERE be.business_id = b.id AND e.is_junk = 0) AS email_count,
      b.first_seen_at AS first_seen
    FROM businesses b
    WHERE b.id > :lastId
    ORDER BY b.id
    LIMIT :limit`,
};

export const EMAILS: RecordSchema = {
  entity: 'emails',
  fields: [
    { name: 'id', kind: 'number' },
    { name: 'email', kind: 'text' },
    { name: 'business_name', kind: 'text' },
    { name: 'business_phone', kind: 'digits' },
    { name: 'city', kind: 'text' },
    { name: 'state', kind: 'text' },
    { name: 'is_role', kind: 'boolean' },
    { name: 'is_free', kind: 'boolean' },
    { name: 'confidence', kind: 'number' },
    { name: 'method', kind: 'text' },
    { name: 'source_url', kind: 'text' },
  ],
  // Junk is deliberately excluded from exports but kept in the database, so a
  // rule that is too aggressive stays auditable.
  sql: `
    SELECT
      be.rowid AS id, e.address AS email, b.name AS business_name,
      b.phone_e164 AS business_phone, b.city AS city, b.state_code AS state,
      e.is_role AS is_role, e.is_free AS is_free,
      be.confidence AS confidence, be.method AS method, be.source_url AS source_url
    FROM business_emails be
    JOIN emails e ON e.id = be.email_id
    JOIN businesses b ON b.id = be.business_id
    WHERE e.is_junk = 0 AND be.rowid > :lastId
    ORDER BY be.rowid
    LIMIT :limit`,
};

export const VIEWS: Record<string, RecordSchema> = {
  'leads-flat': LEADS_FLAT,
  businesses: BUSINESSES,
  emails: EMAILS,
};

export type ViewName = keyof typeof VIEWS;

export type ExportRow = Record<string, string | number | null>;

/** Read one page of rows for a view, starting after `lastId`. */
export function readRows(
  driver: SqliteDriver,
  schema: RecordSchema,
  lastId: number,
  limit: number,
): (ExportRow & { id: number })[] {
  return driver.prepare<ExportRow & { id: number }>(schema.sql).all({ lastId, limit });
}
