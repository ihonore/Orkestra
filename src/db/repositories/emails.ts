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
  /** The address is someone else's — the site's builder or a vendor. See migration 0009. */
  readonly offSite?: boolean;
}

export interface DomainRecord {
  readonly id: number;
  readonly domain: string;
  readonly status: string;
  readonly next_eligible_at: number | null;
  /** The claim's fencing token. Carry it on every write for this domain. */
  readonly crawl_epoch: number;
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

  /** Every stored address with its current verdict, for re-checking. */
  storedVerdicts(): { id: number; address: string; is_junk: number; junk_reason: string | null }[] {
    return this.driver
      .prepare<{ id: number; address: string; is_junk: number; junk_reason: string | null }>(
        `SELECT id, address, is_junk, junk_reason FROM emails`,
      )
      .all();
  }

  /**
   * Mark addresses junk that a newer rule rejects. Only ever junk-wards: an
   * address junked by a rule since loosened is better re-found by a crawl, which
   * also restores its role and free-mail flags.
   */
  markJunk(rejects: readonly { id: number; reason: string }[]): number {
    if (rejects.length === 0) return 0;
    const statement = this.driver.prepare(
      `UPDATE emails SET is_junk = 1, junk_reason = ? WHERE id = ? AND is_junk = 0`,
    );
    return this.inTransaction(() =>
      rejects.reduce((n, r) => n + statement.run([r.reason, r.id]).changes, 0),
    );
  }

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
         is_junk = :isJunk, junk_reason = :junkReason,
         -- Refresh the classification only when this write is a real verdict.
         -- A junk verdict carries no meaningful is_role/is_free — the rules
         -- stop at the first reason to reject — so letting one overwrite them
         -- would blank the flags on an address that is fine. But an address
         -- first stored as a reject and later accepted must not keep the
         -- placeholder flags either, which is what re-running with looser
         -- rules does.
         is_role = CASE WHEN :isJunk = 0 THEN :isRole ELSE is_role END,
         is_free = CASE WHEN :isJunk = 0 THEN :isFree ELSE is_free END
       RETURNING id`,
    );

    this.#linkEmail = driver.prepare(
      `INSERT INTO business_emails (business_id, email_id, source_url, source_domain_id,
                                    method, confidence, page_depth, off_site, first_seen_at)
       VALUES (:businessId, :emailId, :sourceUrl, :sourceDomainId, :method,
               :confidence, :pageDepth, :offSite, :now)
       ON CONFLICT (business_id, email_id) DO UPDATE SET
         off_site = :offSite,
         -- Keep the strongest evidence: a mailto: found later should beat a
         -- body-text match found earlier.
         confidence = MAX(confidence, :confidence),
         method = CASE WHEN :confidence > confidence THEN :method ELSE method END`,
    );

    // Atomic claim, exactly like the job queue: two enrichment workers must
    // never crawl the same domain.
    this.#claimDomain = driver.prepare<DomainRecord>(
      `UPDATE domains
          SET status = 'crawling', last_crawled_at = :now,
              crawl_epoch = crawl_epoch + 1
        WHERE id = (
          SELECT id FROM domains
           WHERE status = 'pending'
             AND is_social = 0
             AND (next_eligible_at IS NULL OR next_eligible_at <= :now)
           ORDER BY id
           LIMIT 1
        )
       RETURNING id, domain, status, next_eligible_at, crawl_epoch,
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
        WHERE id = :id AND crawl_epoch = :epoch`,
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
      offSite: input.offSite === true ? 1 : 0,
      now,
    });
  }

  /** Every link with what judging its ownership needs. */
  linksForReview(): {
    rowid: number;
    local_part: string;
    email_domain: string;
    is_role: number;
    is_free: number;
    off_site: number;
    site: string | null;
    name: string;
  }[] {
    return this.driver
      .prepare<{
        rowid: number;
        local_part: string;
        email_domain: string;
        is_role: number;
        is_free: number;
        off_site: number;
        site: string | null;
        name: string;
      }>(
        `SELECT be.rowid AS rowid, e.local_part, e.email_domain, e.is_role, e.is_free,
                be.off_site, d.domain AS site, b.name
           FROM business_emails be
           JOIN emails e ON e.id = be.email_id
           JOIN businesses b ON b.id = be.business_id
           LEFT JOIN domains d ON d.id = b.domain_id`,
      )
      .all();
  }

  /** Record new ownership verdicts. Returns how many links changed. */
  setOffSite(verdicts: readonly { rowid: number; offSite: boolean }[]): number {
    if (verdicts.length === 0) return 0;
    const statement = this.driver.prepare(
      `UPDATE business_emails SET off_site = ? WHERE rowid = ? AND off_site <> ?`,
    );
    return this.inTransaction(() =>
      verdicts.reduce((n, v) => {
        const flag = v.offSite ? 1 : 0;
        return n + statement.run([flag, v.rowid, flag]).changes;
      }, 0),
    );
  }

  claimDomain(now: Timestamp = Date.now()): DomainRecord | null {
    return this.#claimDomain.get({ now }) ?? null;
  }

  /**
   * Hand one domain back to the queue, unclaimed.
   *
   * Used when a worker stops before it finished — a graceful shutdown, or an
   * error that is not the domain's fault. Without it the row stays 'crawling'
   * forever: the claim only ever selects 'pending', so nothing would look at it
   * again.
   */
  releaseDomain(id: number, epoch: number): boolean {
    return (
      this.driver
        .prepare(
          `UPDATE domains SET status = 'pending'
            WHERE id = :id AND status = 'crawling' AND crawl_epoch = :epoch`,
        )
        .run({ id, epoch }).changes === 1
    );
  }

  /**
   * Return domains abandoned by a dead process to the queue.
   *
   * The equivalent of the job queue's reaper, and it exists for the same
   * reason: a worker killed mid-crawl leaves its domain claimed, and with no
   * recovery path those sites are never enriched again. `last_crawled_at` is
   * stamped at claim time, so it doubles as the lease clock.
   *
   * Deliberately generous — `leaseMs` should comfortably exceed the longest a
   * single domain may take (`maxTimePerDomainMs`), because reclaiming a domain
   * a live worker is still crawling would have both of them writing its
   * results.
   */
  reclaimStalledDomains(leaseMs: number, now: Timestamp = Date.now()): number {
    return this.driver
      .prepare(
        `UPDATE domains SET status = 'pending', crawl_epoch = crawl_epoch + 1
          WHERE status = 'crawling'
            AND (last_crawled_at IS NULL OR last_crawled_at < :cutoff)`,
      )
      .run({ cutoff: now - leaseMs }).changes;
  }

  /**
   * Record the outcome of a crawl.
   *
   * Returns false when this worker no longer owns the claim — the reaper
   * decided it was dead and someone else took the site. The results belong to a
   * claim that no longer exists, so they are dropped rather than written over
   * the new owner's.
   */
  finishDomain(
    id: number,
    epoch: number,
    outcome: DomainCrawlOutcome,
    now: Timestamp = Date.now(),
  ): boolean {
    return (
      this.#finishDomain.run({
        id,
        epoch,
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
      }).changes === 1
    );
  }

  /**
   * What a crawl found about the business beyond addresses: its Instagram,
   * its booking platform, whether it says "sur rendez-vous". A later crawl
   * that finds nothing does not erase an earlier finding.
   */
  setDomainSignals(
    id: number,
    signals: {
      readonly instagramUrl: string | null;
      readonly bookingProvider: string | null;
      readonly bookingUrl: string | null;
      readonly byAppointment: boolean;
    },
  ): void {
    this.driver
      .prepare(
        `UPDATE domains SET
           instagram_url = COALESCE(:instagramUrl, instagram_url),
           booking_provider = COALESCE(:bookingProvider, booking_provider),
           booking_url = COALESCE(:bookingUrl, booking_url),
           by_appointment = MAX(by_appointment, :byAppointment)
         WHERE id = :id`,
      )
      .run({
        id,
        instagramUrl: signals.instagramUrl,
        bookingProvider: signals.bookingProvider,
        bookingUrl: signals.bookingUrl,
        byAppointment: signals.byAppointment ? 1 : 0,
      });
  }

  /** Businesses whose website is on this domain, so found addresses can be linked. */
  businessesForDomain(domainId: number): { id: number; name: string }[] {
    return this.driver
      .prepare<{ id: number; name: string }>(`SELECT id, name FROM businesses WHERE domain_id = ?`)
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

  /** Every opt-out, newest first. */
  listSuppressions(): {
    kind: string;
    value: string;
    reason: string | null;
    created_at: number;
  }[] {
    return this.driver
      .prepare<{ kind: string; value: string; reason: string | null; created_at: number }>(
        `SELECT kind, value, reason, created_at FROM suppressions ORDER BY created_at DESC, id DESC`,
      )
      .all();
  }

  /** Undo an opt-out entered by mistake. Returns whether one was removed. */
  removeSuppression(kind: 'email' | 'domain' | 'phone' | 'cid', value: string): boolean {
    return (
      this.driver
        .prepare(`DELETE FROM suppressions WHERE kind = ? AND value = ?`)
        .run([kind, value.toLowerCase()]).changes > 0
    );
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
