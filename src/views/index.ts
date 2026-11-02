/**
 * Export row shapes.
 *
 * Every exporter reads these, so CSV and Sheets cannot drift into having
 * different columns for the same entity. The `RecordSchema` also declares which
 * fields are *text that looks numeric* — zips, phones, FIPS codes, CIDs — which
 * is the single most important piece of metadata here.
 */
import type { SqliteDriver } from '../db/driver/types.js';
import type { ExportCursor } from '../db/repositories/exports.js';

export type { ExportCursor };

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
  //
  // This view has TWO append-only streams, not one; see {@link readLeadPage}.
  // `sql` here is the no-email stream, which is what a plain readRows() gets.
  sql: leadsFlatSql('b.id > :lastId AND be.link_id IS NULL', 'b.id'),
};

/**
 * The leads-flat SELECT, parameterized by its WHERE and ORDER BY.
 *
 * Non-junk emails come from a subquery rather than an ON-clause filter. Filtered
 * afterwards, a *junk* link still produces a row with a blank email — so a
 * business whose addresses were all rejected would appear once per rejected
 * address, each looking like a business that simply has no email.
 */
function leadsFlatSql(where: string, orderBy: string): string {
  return `
    SELECT
      b.id                                   AS id,
      COALESCE(be.link_id, 0)                AS sub_id,
      b.id                                   AS business_id,
      b.name                                 AS name,
      b.category_primary                     AS category,
      b.phone_e164                           AS phone,
      be.address                             AS email,
      CASE WHEN be.address IS NULL THEN NULL
           WHEN be.is_role = 1 THEN 'role'
           WHEN be.is_free = 1 THEN 'free'
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
    LEFT JOIN (
      SELECT be.rowid AS link_id, be.business_id, be.confidence,
             e.address, e.is_role, e.is_free
        FROM business_emails be
        JOIN emails e ON e.id = be.email_id
       WHERE e.is_junk = 0
    ) be ON be.business_id = b.id
    LEFT JOIN domains d ON d.id = b.domain_id
    LEFT JOIN business_sightings s ON s.id = (
      SELECT id FROM business_sightings WHERE business_id = b.id ORDER BY id LIMIT 1
    )
    LEFT JOIN cities seed_city ON seed_city.id = s.seed_city_id
    LEFT JOIN categories seed_cat ON seed_cat.id = s.seed_category_id
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT :limit`;
}

/** Businesses with no usable email yet. Cursor: `businesses.id`. */
const LEADS_NO_EMAIL = leadsFlatSql('b.id > :lastId AND be.link_id IS NULL', 'b.id');

/**
 * Every email link. Cursor: `business_emails.rowid`, which is unique per row.
 *
 * Deliberately NOT restricted to new businesses: an address found by enrichment
 * for a business exported last week is new information and must still be
 * exported. Missing that is what the single-cursor design got wrong.
 */
const LEADS_WITH_EMAIL = leadsFlatSql('be.link_id > :lastSubId', 'be.link_id');

/**
 * `leads-flat` without the businesses that have no email: one row per address,
 * each sent exactly once, in the order they were found.
 *
 * The full view sends a business with no email as a blank row, and again with
 * the address once enrichment finds one — right for a phone list, wrong for a
 * sheet whose point is email outreach, where it means a blank row per lead and
 * a second row for the same business later. This view has no such row, so
 * shipping it in small batches as emails arrive is exact.
 *
 * Same columns as `leads-flat`, so both can append to one tab.
 */
export const LEADS_WITH_EMAIL_VIEW: RecordSchema = {
  entity: 'leads-with-email',
  fields: LEADS_FLAT.fields,
  sql: LEADS_WITH_EMAIL,
};

/**
 * One row per business that has an email: its best address in `email`, the
 * rest in `other_emails`. What the team's sheet uses by default — a business
 * with five addresses used to fill five rows.
 *
 * "Best" is the address most likely to reach someone who can buy: a named
 * person at the business's own domain, then a role address there (info@,
 * contact@), then anything else that is not free mail, then free mail
 * (gmail.com), and within each, the extractor's confidence.
 *
 * ## Why it can be sent once, and complete
 *
 * The cursor is the business's **first** email link. Link rowids only grow,
 * and every address a crawl finds is linked in one transaction — so a business
 * appears with all of its addresses at once, its first link never changes, and
 * "first link > cursor" is exactly "not sent yet". A business that later gains
 * an address (a recrawl after 90 days) is not sent again; the database and the
 * per-email exports have it. The one way to send a business with only some of
 * its addresses is a crawl stopped mid-way, which commits what it found so far.
 */
const LEADS_BY_BUSINESS_SQL = `
    WITH links AS (
      SELECT be.rowid AS link_id, be.business_id, be.confidence,
             e.address, e.is_role, e.is_free, e.email_domain
        FROM business_emails be
        JOIN emails e ON e.id = be.email_id
       WHERE e.is_junk = 0
    ),
    ranked AS (
      SELECT l.*,
             ROW_NUMBER() OVER (
               PARTITION BY l.business_id
               ORDER BY (l.email_domain = d.domain AND l.is_role = 0 AND l.is_free = 0) DESC,
                        (l.email_domain = d.domain) DESC,
                        l.is_free ASC,
                        l.is_role ASC,
                        l.confidence DESC,
                        l.link_id ASC
             ) AS rank,
             MIN(l.link_id) OVER (PARTITION BY l.business_id) AS first_link,
             COUNT(*) OVER (PARTITION BY l.business_id) AS email_count
        FROM links l
        JOIN businesses b ON b.id = l.business_id
        LEFT JOIN domains d ON d.id = b.domain_id
    ),
    best AS (
      SELECT * FROM ranked WHERE rank = 1 AND first_link > :lastSubId
    )
    SELECT
      b.id                                   AS id,
      best.first_link                        AS sub_id,
      b.id                                   AS business_id,
      b.name                                 AS name,
      b.category_primary                     AS category,
      b.phone_e164                           AS phone,
      best.address                           AS email,
      CASE WHEN best.is_role = 1 THEN 'role'
           WHEN best.is_free = 1 THEN 'free'
           ELSE 'personal' END               AS email_type,
      (SELECT GROUP_CONCAT(address, ', ')
         FROM (SELECT r.address FROM ranked r
                WHERE r.business_id = b.id AND r.rank > 1
                ORDER BY r.rank))            AS other_emails,
      best.email_count                       AS email_count,
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
    FROM best
    JOIN businesses b ON b.id = best.business_id
    LEFT JOIN domains d ON d.id = b.domain_id
    LEFT JOIN business_sightings s ON s.id = (
      SELECT id FROM business_sightings WHERE business_id = b.id ORDER BY id LIMIT 1
    )
    LEFT JOIN cities seed_city ON seed_city.id = s.seed_city_id
    LEFT JOIN categories seed_cat ON seed_cat.id = s.seed_category_id
    ORDER BY best.first_link
    LIMIT :limit`;

export const LEADS_BY_BUSINESS: RecordSchema = {
  entity: 'leads-by-business',
  fields: [
    { name: 'business_id', kind: 'number' },
    { name: 'name', kind: 'text' },
    { name: 'category', kind: 'text' },
    { name: 'phone', kind: 'digits', description: 'E.164' },
    { name: 'email', kind: 'text', description: 'the best address' },
    { name: 'email_type', kind: 'text', description: 'personal | role | free' },
    { name: 'other_emails', kind: 'text', description: 'the rest, best first' },
    { name: 'email_count', kind: 'number' },
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
  sql: LEADS_BY_BUSINESS_SQL,
};

/** How the team's sheet lists leads, and the view each layout sends. */
export type SheetLayout = 'business' | 'email' | 'all';
export const SHEET_LAYOUT_ENTITY: Record<SheetLayout, string> = {
  business: 'leads-by-business',
  email: 'leads-with-email',
  all: 'leads-flat',
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
  'leads-with-email': LEADS_WITH_EMAIL_VIEW,
  'leads-by-business': LEADS_BY_BUSINESS,
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

export interface Page {
  readonly rows: (ExportRow & { id: number })[];
  readonly next: ExportCursor;
  /** True when the view has nothing left beyond `next`. */
  readonly done: boolean;
}

/** Row shape of the leads streams, which carry a second cursor column. */
type LeadRow = ExportRow & { id: number; sub_id: number };

/**
 * Read one page of `leads-flat`.
 *
 * The view's grain is (business, email), so a single `businesses.id` watermark
 * cannot describe it — two rows share an id, and an email discovered later has
 * an id already behind the mark. Instead there are two streams, each with a
 * genuinely unique, monotone cursor:
 *
 *  - **email links**, keyed on `business_emails.rowid`. Covers every address,
 *    including ones enrichment finds long after the business was exported.
 *  - **businesses with no email yet**, keyed on `businesses.id`. These are still
 *    leads — reachable by phone — so they are not dropped.
 *
 * A business exported blank that later gains an address appears a second time,
 * with the address. That is a new fact rather than a duplicate, and it is the
 * behaviour that makes running an export repeatedly actually work.
 */
export function readLeadPage(driver: SqliteDriver, cursor: ExportCursor, limit: number): Page {
  // Emails first: they are the point of the export, and this stream also
  // catches up on anything enrichment added since the last run.
  const withEmail = driver
    .prepare<LeadRow>(LEADS_WITH_EMAIL)
    .all({ lastSubId: cursor.lastSubId, limit });

  if (withEmail.length > 0) {
    return {
      rows: withEmail,
      next: { lastId: cursor.lastId, lastSubId: withEmail.at(-1)!.sub_id },
      done: false,
    };
  }

  const noEmail = driver.prepare<LeadRow>(LEADS_NO_EMAIL).all({ lastId: cursor.lastId, limit });

  return {
    rows: noEmail,
    next: {
      lastId: noEmail.length > 0 ? noEmail.at(-1)!.id : cursor.lastId,
      lastSubId: cursor.lastSubId,
    },
    done: noEmail.length === 0,
  };
}

/**
 * Read one page of any view.
 *
 * Every exporter goes through this rather than paging itself, so a view with an
 * unusual cursor is handled in exactly one place. Before this existed, CSV and
 * Sheets each ran their own `id > lastId` loop and both inherited the same bug.
 */
export function readPage(
  driver: SqliteDriver,
  schema: RecordSchema,
  cursor: ExportCursor,
  limit: number,
): Page {
  if (schema.entity === LEADS_FLAT.entity) return readLeadPage(driver, cursor, limit);
  // Its cursor is the email link, which lives in `lastSubId` exactly as it does
  // for leads-flat's email stream — so one can continue from the other.
  // Both page on `sub_id` held in `lastSubId`: the email link for one, the
  // business's first email link for the other.
  if (
    schema.entity === LEADS_WITH_EMAIL_VIEW.entity ||
    schema.entity === LEADS_BY_BUSINESS.entity
  ) {
    const rows = driver.prepare<LeadRow>(schema.sql).all({ lastSubId: cursor.lastSubId, limit });
    return {
      rows,
      next: { lastId: cursor.lastId, lastSubId: rows.at(-1)?.sub_id ?? cursor.lastSubId },
      done: rows.length === 0,
    };
  }

  const rows = readRows(driver, schema, cursor.lastId, limit);
  return {
    rows,
    next: { lastId: rows.at(-1)?.id ?? cursor.lastId, lastSubId: cursor.lastSubId },
    done: rows.length === 0,
  };
}

/** Count the rows a SELECT would return, ignoring its LIMIT. */
function countOf(driver: SqliteDriver, sql: string, params: Record<string, number>): number {
  // The parameter must go too, not just the clause: better-sqlite3 rejects a
  // named parameter the statement does not mention.
  const unlimited = sql.replace('LIMIT :limit', '');
  return (
    driver.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM (${unlimited})`).get(params)?.n ?? 0
  );
}

/**
 * How many rows a view still owes beyond `cursor`.
 *
 * Uses the same SQL the reader uses, so the number shown before an export and
 * the number of rows that actually arrive cannot disagree.
 */
export function countRemaining(
  driver: SqliteDriver,
  schema: RecordSchema,
  cursor: ExportCursor,
): number {
  if (schema.entity === LEADS_FLAT.entity) {
    return (
      countOf(driver, LEADS_WITH_EMAIL, { lastSubId: cursor.lastSubId }) +
      countOf(driver, LEADS_NO_EMAIL, { lastId: cursor.lastId })
    );
  }
  if (
    schema.entity === LEADS_WITH_EMAIL_VIEW.entity ||
    schema.entity === LEADS_BY_BUSINESS.entity
  ) {
    return countOf(driver, schema.sql, { lastSubId: cursor.lastSubId });
  }
  return countOf(driver, schema.sql, { lastId: cursor.lastId });
}

/**
 * Where an export of `entity` to a target starts, given both lead cursors there.
 *
 * `leads-flat` and `leads-with-email` share one email stream, keyed on the
 * email link, and can both append to the same tab — the dashboard's button and
 * autopilot may well use one each. So for either, the email stream resumes
 * from the *further* of the two cursors: whatever one sent, the other must not
 * send again. `leads-flat`'s second stream (businesses without an email) is its
 * own alone.
 *
 * Pass `other` as null to ignore it, as `--full` does.
 */
export function startingCursor(
  entity: string,
  own: ExportCursor | null,
  other: ExportCursor | null,
): ExportCursor {
  const base = own ?? { lastId: 0, lastSubId: 0 };
  const shared = entity === LEADS_FLAT.entity || entity === LEADS_WITH_EMAIL_VIEW.entity;
  if (!shared || other === null) return base;
  return { lastId: base.lastId, lastSubId: Math.max(base.lastSubId, other.lastSubId) };
}

/** The view whose email stream is shared with `entity`'s, if any. */
export function sharedLeadEntity(entity: string): string | null {
  if (entity === LEADS_FLAT.entity) return LEADS_WITH_EMAIL_VIEW.entity;
  if (entity === LEADS_WITH_EMAIL_VIEW.entity) return LEADS_FLAT.entity;
  return null;
}
