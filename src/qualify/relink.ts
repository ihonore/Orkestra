/**
 * File each business's website under the domain the current rules give it.
 *
 * What counts as a website keeps changing as new cases turn up: a booking
 * platform nobody had listed (setmore.com), a site builder whose customers
 * each get a subdomain (now.site), a WhatsApp link. Businesses stored before
 * such a fix still point at the old domain row, where salons that have
 * nothing to do with each other share one "website". Two things go wrong:
 * the qualification takes them for a chain, and the single crawl of that
 * shared row pins one salon's address — or the platform's — on all of them.
 *
 * This pass moves each business to the row its website maps to now, drops
 * the address links the old row's crawl gave it, marks rows that are not
 * websites as such, and records a booking platform the website field
 * reveals. It runs before every qualification, so a fix to the lists applies
 * to everything already found.
 */
import { mergeProviders, OWN_SITE_BOOKING, signalsFrom } from '../core/util/business-links.js';
import type { SqliteDriver } from '../db/driver/types.js';

export interface WebsiteDomain {
  readonly domain: string;
  /** Not the business's own site: never crawled, never a chain's site. */
  readonly isSocial: boolean;
}

/** How a website URL is filed; `domainOf` in the Maps automation. */
export type ClassifyWebsite = (websiteUrl: string) => WebsiteDomain | null;

export interface RelinkReport {
  /** Businesses moved to another domain row. */
  readonly moved: number;
  /** Domain rows found not to be anyone's website. */
  readonly notWebsites: number;
  /** Address links dropped because they came from someone else's site. */
  readonly linksDropped: number;
  /** Businesses whose booking platform was added or renamed. */
  readonly bookingUpdated: number;
}

interface Link {
  business_id: number;
  email_id: number;
  source_url: string;
  website_url: string | null;
}

/** Host without `www`, and path without a trailing slash; null if not a URL. */
function page(url: string | null): { host: string; path: string } | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.toLowerCase().replace(/^www\./, ''),
      path: parsed.pathname.replace(/\/+$/, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Whether an address was found on the business's own page of a shared host:
 * twistedbraids.setmore.com for Twisted Braids, sumupbookings.com/les-gaphas
 * for Les Gaphas. The host's home page and contact page are everyone's.
 */
export function foundOnOwnPage(
  sourceUrl: string,
  websiteUrl: string | null,
  sharedDomain: string,
): boolean {
  const site = page(websiteUrl);
  const source = page(sourceUrl);
  if (site === null || source === null || site.host !== source.host) return false;
  if (site.path === '' && site.host === sharedDomain) return false;
  return source.path === site.path || source.path.startsWith(`${site.path}/`);
}

function withoutOwnSite(providers: string | null): string | null {
  const rest = (providers ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== OWN_SITE_BOOKING);
  return rest.length > 0 ? rest.join(', ') : null;
}

interface Row {
  id: number;
  website_url: string;
  domain_id: number | null;
  domain: string | null;
  booking_provider: string | null;
}

export function relinkWebsites(
  driver: SqliteDriver,
  classify: ClassifyWebsite,
  now: number = Date.now(),
): RelinkReport {
  return driver.transaction(() => {
    const rows = driver
      .prepare<Row>(
        `SELECT b.id, b.website_url, b.domain_id, d.domain, b.booking_provider
           FROM businesses b
           LEFT JOIN domains d ON d.id = b.domain_id
          WHERE b.website_url IS NOT NULL`,
      )
      .all();

    const upsertDomain = driver.prepare<{ id: number }>(
      `INSERT INTO domains (domain, is_social, status, created_at)
       VALUES (:domain, :isSocial, :status, :now)
       ON CONFLICT (domain) DO UPDATE SET domain = domain
       RETURNING id`,
    );
    const move = driver.prepare(`UPDATE businesses SET domain_id = :domainId WHERE id = :id`);
    const setBooking = driver.prepare(
      `UPDATE businesses
          SET booking_provider = :provider, booking_url = COALESCE(booking_url, :url)
        WHERE id = :id`,
    );
    const linksOf = driver.prepare<Link>(
      `SELECT be.business_id, be.email_id, be.source_url, b.website_url
         FROM business_emails be
         JOIN businesses b ON b.id = be.business_id
        WHERE be.source_domain_id = :domainId AND (:id IS NULL OR be.business_id = :id)`,
    );
    const dropLink = driver.prepare(
      `DELETE FROM business_emails WHERE business_id = :businessId AND email_id = :emailId`,
    );
    const keepLink = driver.prepare(
      `UPDATE business_emails SET source_domain_id = :domainId
        WHERE business_id = :businessId AND email_id = :emailId`,
    );

    let linksDropped = 0;
    /**
     * Drop the links a shared row's crawl gave, keeping those found on the
     * business's own page there; `to` is the row a kept link now belongs to.
     */
    const sortLinks = (from: number, shared: string, id: number | null, to: number): void => {
      for (const link of linksOf.all({ domainId: from, id })) {
        const key = { businessId: link.business_id, emailId: link.email_id };
        if (foundOnOwnPage(link.source_url, link.website_url, shared)) {
          if (to !== from) keepLink.run({ ...key, domainId: to });
        } else {
          dropLink.run(key);
          linksDropped += 1;
        }
      }
    };

    let moved = 0;
    let bookingUpdated = 0;
    const social = new Set<string>();
    const left = new Set<number>();

    for (const row of rows) {
      const info = classify(row.website_url);
      if (info === null) continue;
      if (info.isSocial) social.add(info.domain);

      // As the scraper reads it: a Google booking link to the business's own
      // website is "own site" — unless that website is a booking platform,
      // in which case the platform is what "own site" meant.
      const site = signalsFrom([row.website_url], info.domain);
      const onPlatform = site.bookingProvider !== null && site.bookingProvider !== OWN_SITE_BOOKING;
      const stored = onPlatform ? withoutOwnSite(row.booking_provider) : row.booking_provider;
      const provider = mergeProviders(stored, onPlatform ? site.bookingProvider : null);
      if (provider !== row.booking_provider) {
        setBooking.run({ id: row.id, provider, url: onPlatform ? site.bookingUrl : null });
        bookingUpdated += 1;
      }

      if (row.domain === info.domain) continue;
      const target = upsertDomain.get({
        domain: info.domain,
        isSocial: info.isSocial ? 1 : 0,
        status: info.isSocial ? 'skipped' : 'pending',
        now,
      });
      if (target === undefined) throw new Error(`domain upsert returned no row for ${info.domain}`);
      move.run({ id: row.id, domainId: target.id });
      moved += 1;
      if (row.domain_id !== null && row.domain !== null) {
        sortLinks(row.domain_id, row.domain, row.id, target.id);
        left.add(row.domain_id);
      }
    }

    // A row that turns out not to be a website: never crawled again, and what
    // its crawl found was the platform's, or another salon's.
    let notWebsites = 0;
    const findDomain = driver.prepare<{ id: number; is_social: number }>(
      `SELECT id, is_social FROM domains WHERE domain = :domain`,
    );
    const markNotWebsite = driver.prepare(
      `UPDATE domains
          SET is_social = 1,
              status = CASE WHEN status IN ('done', 'parked') THEN status ELSE 'skipped' END
        WHERE id = :id`,
    );
    for (const domain of social) {
      const row = findDomain.get({ domain });
      if (row === undefined || row.is_social === 1) continue;
      markNotWebsite.run({ id: row.id });
      sortLinks(row.id, domain, null, row.id);
      notWebsites += 1;
    }

    // A row every business has moved off leaves the crawl queue.
    const retire = driver.prepare(
      `UPDATE domains SET status = 'skipped', error = 'unused'
        WHERE id = :id AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM businesses b WHERE b.domain_id = domains.id)`,
    );
    for (const id of left) retire.run({ id });

    return { moved, notWebsites, linksDropped, bookingUpdated };
  }, 'immediate');
}
