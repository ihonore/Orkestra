/**
 * Emails, their links to businesses, and the domain crawl queue.
 *
 * One row per address, never a comma-joined cell. The legacy sheet packed every
 * address for a business into one field, which made per-address suppression,
 * validation and deduplication impossible — and is why a single Sentry DSN could
 * sit in a "contact" column for months unnoticed.
 */
import type { PreparedStatement, SqliteDriver } from '../driver/types.js';
import { BaseRepository, type Timestamp } from './types.js';

export interface EmailInput {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
  readonly isRole: boolean;
  readonly isFree: boolean;
  readonly isJunk: boolean;
  readonly junkReason: string | null;
}

export interface BusinessEmailLink {
  readonly businessId: number;
  readonly emailId: number;
  readonly sourceUrl: string;
  readonly sourceDomainId: number | null;
  readonly method: string;
  readonly confidence: number;
  readonly pageDepth: number | null;
}

export interface DomainRecord {
  readonly id: number;
  readonly domain: string;
  readonly status: string;
  readonly next_eligible_at: number | null;
  /** A real website URL observed for this domain, if any business has one. */
  readonly known_url: string | null;
}

export interface DomainCrawlOutcome {
  readonly status: 'done' | 'failed' | 'skipped' | 'parked';
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly isParked: boolean;
  readonly isDirectoryLike: boolean;
  readonly pagesFetched: number;
  readonly bytesFetched: number;
  readonly emailsFound: number;
  readonly error: string | null;
  /** When this domain may be recrawled. */
  readonly nextEligibleAt: number | null;
}

export class EmailsRepository extends BaseRepository {
  readonly #insertEmail: PreparedStatement<{ id: number }>;
  readonly #findEmail: PreparedStatement<{ id: number }>;
  readonly #linkEmail: PreparedStatement;
  readonly #claimDomain: PreparedStatement<DomainRecord>;
  readonly #finishDomain: PreparedStatement;
  readonly #isSuppressed: PreparedStatement<{ n: number }>;

  constructor(driver: SqliteDriver) {
    super(driver);

    this.#findEmail = driver.prepare<{ id: number }>(`SELECT id FROM emails WHERE address = ?`);

    this.#insertEmail = driver.prepare<{ id: number }>(
      `INSERT INTO emails (address, local_part, email_domain, is_role, is_free,
                           is_junk, junk_reason, first_seen_at)
       VALUES (:address, :localPart, :domain, :isRole, :isFree, :isJunk, :junkReason, :now)
       ON CONFLICT (address) DO UPDATE SET
         -- An address previously seen as junk can be re-classified when the
         -- rules change; the reverse must also hold.
         is_junk = :isJunk, junk_reason = :junkReason
       RETURNING id`,
    );

    this.#linkEmail = driver.prepare(
      `INSERT INTO business_emails (business_id, email_id, source_url, source_domain_id,
                                    method, confidence, page_depth, first_seen_at)
       VALUES (:businessId, :emailId, :sourceUrl, :sourceDomainId, :method,
               :confidence, :pageDepth, :now)
       ON CONFLICT (business_id, email_id) DO UPDATE SET
         -- Keep the strongest evidence: a mailto: found later should beat a
         -- body-text match found earlier.
         confidence = MAX(confidence, :confidence),
         method = CASE WHEN :confidence > confidence THEN :method ELSE method END`,
    );

    // Atomic claim, exactly like the job queue: two enrichment workers must
    // never crawl the same domain.
    this.#claimDomain = driver.prepare<DomainRecord>(
      `UPDATE domains
          SET status = 'crawling', last_crawled_at = :now
        WHERE id = (
          SELECT id FROM domains
           WHERE status = 'pending'
             AND is_social = 0
             AND (next_eligible_at IS NULL OR next_eligible_at <= :now)
           ORDER BY id
           LIMIT 1
        )
       RETURNING id, domain, status, next_eligible_at,
                 -- The real URL Google gave us, which is far better than a
                 -- constructed https://<domain>: many sites 404 on the bare
                 -- apex and only answer on www, and some live on a path
                 -- (https://www.rotorooter.com/birmingham/). Guessing instead
                 -- of using this produced 404s on 19 of 25 domains.
                 (SELECT website_url FROM businesses
                   WHERE businesses.domain_id = domains.id AND website_url IS NOT NULL
                   ORDER BY LENGTH(website_url) LIMIT 1) AS known_url`,
    );

    this.#finishDomain = driver.prepare(
      `UPDATE domains
          SET status = :status, http_status = :httpStatus, final_url = :finalUrl,
              is_parked = :isParked, is_directory_like = :isDirectoryLike,
              pages_fetched = pages_fetched + :pagesFetched,
              bytes_fetched = bytes_fetched + :bytesFetched,
              emails_found = :emailsFound, error = :error,
              last_crawled_at = :now, next_eligible_at = :nextEligibleAt
        WHERE id = :id`,
    );

    this.#isSuppressed = driver.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM suppressions WHERE kind = ? AND value = ?`,
    );
  }

  /** Insert or re-classify an address, returning its id. */
  upsertEmail(input: EmailInput, now: Timestamp = Date.now()): number {
    const row = this.#insertEmail.get({
      address: input.address,
      localPart: input.localPart,
      domain: input.domain,
      isRole: input.isRole ? 1 : 0,
      isFree: input.isFree ? 1 : 0,
      isJunk: input.isJunk ? 1 : 0,
      junkReason: input.junkReason,
      now,
    });
    if (row !== undefined) return row.id;

    // ON CONFLICT DO UPDATE always returns a row, so this is unreachable in
    // practice; kept so a future schema change cannot fail silently.
    const existing = this.#findEmail.get([input.address]);
    if (existing === undefined) throw new Error(`email upsert returned no row: ${input.address}`);
    return existing.id;
  }

  link(input: BusinessEmailLink, now: Timestamp = Date.now()): void {
    this.#linkEmail.run({
      businessId: input.businessId,
      emailId: input.emailId,
      sourceUrl: input.sourceUrl,
      sourceDomainId: input.sourceDomainId,
      method: input.method,
      confidence: input.confidence,
      pageDepth: input.pageDepth,
      now,
    });
  }

  claimDomain(now: Timestamp = Date.now()): DomainRecord | null {
    return this.#claimDomain.get({ now }) ?? null;
  }

  finishDomain(id: number, outcome: DomainCrawlOutcome, now: Timestamp = Date.now()): void {
    this.#finishDomain.run({
      id,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      finalUrl: outcome.finalUrl,
      isParked: outcome.isParked ? 1 : 0,
      isDirectoryLike: outcome.isDirectoryLike ? 1 : 0,
      pagesFetched: outcome.pagesFetched,
      bytesFetched: outcome.bytesFetched,
      emailsFound: outcome.emailsFound,
      error: outcome.error,
      nextEligibleAt: outcome.nextEligibleAt,
      now,
    });
  }

  /** Businesses whose website is on this domain, so found addresses can be linked. */
  businessesForDomain(domainId: number): { id: number }[] {
    return this.driver
      .prepare<{ id: number }>(`SELECT id FROM businesses WHERE domain_id = ?`)
      .all([domainId]);
  }

  isSuppressed(kind: 'email' | 'domain' | 'phone' | 'cid', value: string): boolean {
    return (this.#isSuppressed.get([kind, value])?.n ?? 0) > 0;
  }

  addSuppression(
    kind: 'email' | 'domain' | 'phone' | 'cid',
    value: string,
    reason: string | null = null,
    now: Timestamp = Date.now(),
  ): void {
    this.driver
      .prepare(
        `INSERT INTO suppressions (kind, value, reason, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (kind, value) DO NOTHING`,
      )
      .run([kind, value.toLowerCase(), reason, now]);
  }

  /** Counts for the enrichment summary. */
  stats(): Record<string, number> {
    const row = this.driver
      .prepare<Record<string, number>>(
        `SELECT
           (SELECT COUNT(*) FROM emails)                              AS emails_total,
           (SELECT COUNT(*) FROM emails WHERE is_junk = 0)            AS emails_usable,
           (SELECT COUNT(*) FROM emails WHERE is_junk = 0 AND is_role = 0) AS emails_personal,
           (SELECT COUNT(*) FROM business_emails)                     AS links,
           (SELECT COUNT(DISTINCT business_id) FROM business_emails)  AS businesses_with_email,
           (SELECT COUNT(*) FROM domains WHERE status = 'pending')    AS domains_pending,
           (SELECT COUNT(*) FROM domains WHERE status = 'done')       AS domains_done,
           (SELECT COUNT(*) FROM domains WHERE status = 'failed')     AS domains_failed,
           (SELECT COUNT(*) FROM domains WHERE status = 'parked')     AS domains_parked,
           (SELECT COUNT(*) FROM domains WHERE status = 'skipped')    AS domains_skipped`,
      )
      .get();
    return row ?? {};
  }

  /** Junk counts by reason, so a rule that is too aggressive is visible. */
  junkBreakdown(): { reason: string; n: number }[] {
    return this.driver
      .prepare<{ reason: string; n: number }>(
        `SELECT COALESCE(junk_reason, 'unknown') AS reason, COUNT(*) AS n
           FROM emails WHERE is_junk = 1 GROUP BY reason ORDER BY n DESC`,
      )
      .all();
  }
}
