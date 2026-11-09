/**
 * The per-domain email crawl.
 *
 * One domain, one budget. Every limit is enforced simultaneously — pages, time,
 * and bytes — because any one of them alone has a failure mode: a page cap does
 * not stop a site that takes 40 seconds per request, and a time cap does not
 * stop a site that serves 50 MB pages.
 *
 * Crawling is keyed on the *domain*, not the business. A franchise's shared
 * website is crawled once for all its locations, which turns ~15,000 businesses
 * into a few thousand crawls.
 */
import { fetchRobots, fetchPage, ALLOW_ALL, type RobotsRules } from '../../core/http/fetcher.js';
import { humanPause } from '../../core/browser/humanize.js';
import {
  classifyLink,
  saysByAppointment,
  signalsFrom,
  type BusinessSignals,
} from '../../core/util/business-links.js';
import type { Logger } from '../../core/logging/logger.js';
import type { ProxySettings } from '../../core/proxy/types.js';
import { extractEmails, type ExtractionMethod } from './extract/index.js';
import { COMMON_CONTACT_PATHS, LinkFrontier, extractLinks, canonicalize } from './frontier.js';
import {
  confidenceFor,
  validateEmail,
  type EmailVerdict,
  type ValidationOptions,
} from './validate/rules.js';

export interface CrawlOptions {
  readonly domain: string;
  readonly startUrl: string;
  /** Sent with every request, so a bilingual site answers in this language. */
  readonly acceptLanguage?: string;
  /** Paths tried on every site. Default: {@link COMMON_CONTACT_PATHS}. */
  readonly guessPaths?: readonly string[];
  readonly maxDepth?: number;
  readonly maxPages?: number;
  readonly maxTimeMs?: number;
  readonly maxBytes?: number;
  /** Stop once this many usable addresses are found. */
  readonly stopAfterEmails?: number;
  /** A page yielding more than this looks like a directory, not a business. */
  readonly maxEmailsPerPage?: number;
  readonly maxEmailsPerDomain?: number;
  readonly respectRobots?: boolean;
  readonly followSubdomains?: boolean;
  readonly perRequestDelayMs?: readonly [number, number];
  readonly validation?: ValidationOptions;
  readonly proxy?: ProxySettings | null;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export interface CrawledEmail {
  readonly verdict: EmailVerdict;
  readonly method: ExtractionMethod;
  readonly sourceUrl: string;
  readonly depth: number;
  readonly confidence: number;
}

/**
 * An address a rule threw away, kept so the rule stays reviewable.
 *
 * Rejects are not linked to businesses and never reach an export. They exist so
 * `gms enrich emails` can show *what* it discarded and why: a validation rule
 * that is too aggressive is invisible otherwise, and one already cost this
 * project a real law firm's address (`BG@rushtonstakely.com`, read as an image
 * filename). Discarding silently makes that mistake permanent and unnoticed.
 */
export interface RejectedEmail {
  readonly verdict: EmailVerdict;
  readonly sourceUrl: string;
}

export type CrawlStatus = 'done' | 'failed' | 'skipped' | 'parked';

export interface CrawlResult {
  readonly domain: string;
  readonly status: CrawlStatus;
  readonly emails: CrawledEmail[];
  /** Addresses a validation rule rejected. Never linked, never exported. */
  readonly rejected: RejectedEmail[];
  readonly pagesFetched: number;
  readonly bytesFetched: number;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly isParked: boolean;
  readonly isDirectoryLike: boolean;
  readonly usedRobots: boolean;
  readonly error: string | null;
  readonly stoppedBecause: string;
  /** Instagram and booking links the site carries, and whether it says "sur rendez-vous". */
  readonly signals: BusinessSignals & { readonly byAppointment: boolean };
}

/** Phrases that mean the domain is for sale or unconfigured. */
const PARKED_MARKERS =
  /(this domain (is|may be) for sale|buy this domain|parked (free )?(at|by)|domain (parking|expired)|under construction|coming soon|godaddy\.com\/domainsearch|sedoparking|site en construction|nom de domaine (est )?(à|a) vendre|ce domaine est (à|a) vendre|bient(ô|o)t disponible)/i;

/**
 * Crawl one domain for addresses.
 *
 * Never throws: a crawl of a dead or hostile site is an expected outcome, and
 * the caller records the result either way.
 */
export async function crawlDomain(options: CrawlOptions): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 8;
  const maxTimeMs = options.maxTimeMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxEmailsPerPage = options.maxEmailsPerPage ?? 5;
  const maxEmailsPerDomain = options.maxEmailsPerDomain ?? 25;
  const stopAfterEmails = options.stopAfterEmails ?? maxEmailsPerDomain;

  const startedAt = Date.now();
  const found = new Map<string, CrawledEmail>();
  const rejected = new Map<string, RejectedEmail>();
  let pagesFetched = 0;
  let bytesFetched = 0;
  let httpStatus: number | null = null;
  let finalUrl: string | null = null;
  let isParked = false;
  let isDirectoryLike = false;
  let stoppedBecause = 'frontier-empty';

  // Off-site links that say something about the business: its Instagram, the
  // booking platform its "Prendre rendez-vous" button goes to.
  const siteLinks: string[] = [];
  let byAppointment = false;

  const base = (): { origin: string; hostname: string } | null => {
    try {
      const start = new URL(options.startUrl);
      return { origin: start.origin, hostname: start.hostname };
    } catch {
      return null;
    }
  };
  const origin = base();
  if (origin === null) {
    return result('failed', 'invalid start URL');
  }

  function result(status: CrawlStatus, error: string | null = null): CrawlResult {
    return {
      domain: options.domain,
      status,
      emails: [...found.values()],
      rejected: [...rejected.values()],
      pagesFetched,
      bytesFetched,
      httpStatus,
      finalUrl,
      isParked,
      isDirectoryLike,
      usedRobots: options.respectRobots !== false,
      error,
      stoppedBecause,
      signals: { ...signalsFrom(siteLinks, options.domain), byAppointment },
    };
  }

  // robots.txt once per domain. A failure to read it means allow-all: a missing
  // file is the overwhelmingly common case and is not a refusal.
  let robots: RobotsRules = ALLOW_ALL;
  if (options.respectRobots !== false) {
    robots = await fetchRobots(origin.origin, {
      ...(options.proxy !== undefined && { proxy: options.proxy }),
      timeoutMs: 10_000,
    });
  }

  const frontier = new LinkFrontier({
    maxDepth: options.maxDepth ?? 1,
    siteDomain: options.domain,
    startHost: origin.hostname,
    ...(options.followSubdomains !== undefined && { followSubdomains: options.followSubdomains }),
  });
  frontier.offer(options.startUrl, { depth: 0 });

  // Conventional contact paths, tried early. Many sites hide these behind a
  // JavaScript menu this crawler cannot see, and each guess is one cheap request.
  for (const path of options.guessPaths ?? COMMON_CONTACT_PATHS) {
    try {
      frontier.offer(new URL(path, origin.origin).toString(), { depth: 1, inNavOrFooter: true });
    } catch {
      // Ignore an unbuildable URL.
    }
  }

  // A site's own Crawl-delay wins when it asks for more than our default.
  const [minDelay, maxDelay] = options.perRequestDelayMs ?? [250, 900];
  const robotsDelayMs = (robots.crawlDelaySeconds ?? 0) * 1_000;
  const delayRange: readonly [number, number] = [
    Math.max(minDelay, robotsDelayMs),
    Math.max(maxDelay, robotsDelayMs),
  ];

  while (pagesFetched < maxPages) {
    if (options.signal?.aborted === true) {
      stoppedBecause = 'aborted';
      break;
    }
    if (Date.now() - startedAt > maxTimeMs) {
      stoppedBecause = 'time-budget';
      break;
    }
    if (bytesFetched > maxBytes) {
      stoppedBecause = 'byte-budget';
      break;
    }
    if (found.size >= stopAfterEmails) {
      stoppedBecause = 'enough-emails';
      break;
    }

    const next = frontier.take();
    if (next === null) break;

    let path: string;
    try {
      path = new URL(next.url).pathname;
    } catch {
      continue;
    }
    if (!robots.allowed(path)) {
      options.logger?.debug({ url: next.url }, 'skipped by robots.txt');
      continue;
    }

    const page = await fetchPage(next.url, {
      timeoutMs: 15_000,
      ...(options.acceptLanguage !== undefined && { acceptLanguage: options.acceptLanguage }),
      maxBytes: Math.min(2 * 1024 * 1024, maxBytes - bytesFetched),
      ...(options.proxy !== undefined && { proxy: options.proxy }),
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    pagesFetched += 1;
    bytesFetched += page.bytes;
    if (httpStatus === null) httpStatus = page.status;
    if (finalUrl === null && page.ok) finalUrl = page.url;

    if (!page.ok || page.body === '') {
      // Only the *entry point* failing means the site is dead. A guessed
      // `/contact` returning 404 is entirely normal and must not condemn the
      // domain — which is what a `pagesFetched === 1` test did, because the
      // frontier does not necessarily fetch the start URL first.
      if (next.depth === 0 && !page.ok) {
        // Many sites answer only on www, or only on the apex. Google's own URL
        // is not always the working one, so try the other form once before
        // giving up: 12 of 40 domains 404'd on the apex while www served fine.
        const alternate = toggleWww(next.url);
        if (alternate !== null && !frontier.hasVisited(alternate)) {
          frontier.offer(alternate, { depth: 0 });
          continue;
        }
        stoppedBecause = 'landing-page-failed';
        return result('failed', page.error ?? `HTTP ${page.status}`);
      }
      continue;
    }

    if (pagesFetched === 1 && PARKED_MARKERS.test(page.body)) {
      isParked = true;
      stoppedBecause = 'parked';
      return result('parked');
    }

    // ── Signals: every page, whatever its depth ───────────────────────────────
    const links = extractLinks(page.body, page.url);
    for (const link of links) {
      if (siteLinks.length < 50 && classifyLink(link.url, options.domain) !== null) {
        siteLinks.push(link.url);
      }
    }
    if (!byAppointment && saysByAppointment(visibleText(page.body))) byAppointment = true;

    // ── Extract and validate ────────────────────────────────────────────────
    const candidates = extractEmails(page.body);
    let keptOnPage = 0;

    for (const candidate of candidates) {
      const verdict = validateEmail(candidate.raw, options.validation ?? {});
      if (verdict.isJunk) {
        // Recorded rather than dropped, but bounded by the same ceiling as real
        // addresses so a staff directory cannot fill the table with noise.
        if (!rejected.has(verdict.address) && rejected.size < maxEmailsPerDomain) {
          rejected.set(verdict.address, { verdict, sourceUrl: next.url });
        }
        continue;
      }
      if (found.has(verdict.address)) continue;

      // A page offering more addresses than any business has is a directory or
      // a staff listing. This is the rule that stops one university page
      // contributing 67 addresses, as cau.edu did to the legacy dataset.
      if (keptOnPage >= maxEmailsPerPage) {
        isDirectoryLike = true;
        options.logger?.debug(
          { url: next.url, found: candidates.length },
          'page looks like a directory — capping',
        );
        break;
      }

      found.set(verdict.address, {
        verdict,
        method: candidate.method,
        sourceUrl: next.url,
        depth: next.depth,
        confidence: confidenceFor(verdict, options.domain),
      });
      keptOnPage += 1;

      if (found.size >= maxEmailsPerDomain) {
        isDirectoryLike = found.size >= maxEmailsPerDomain;
        break;
      }
    }

    // ── Queue further links ─────────────────────────────────────────────────
    if (next.depth < (options.maxDepth ?? 1)) {
      for (const link of links) {
        frontier.offer(link.url, {
          depth: next.depth + 1,
          anchorText: link.anchorText,
          inNavOrFooter: link.inNavOrFooter,
        });
      }
    }

    if (frontier.size > 0 && pagesFetched < maxPages) {
      await humanPause(delayRange, options.signal !== undefined ? { signal: options.signal } : {});
    }
  }

  // Not when the caller aborted: that reason decides whether the domain is
  // recorded as crawled or handed back, so it must not be overwritten by a
  // budget that merely happened to be reached at the same moment.
  if (pagesFetched >= maxPages && stoppedBecause !== 'aborted') stoppedBecause = 'page-budget';
  return result('done');
}

/** A page's text, roughly: scripts, styles and tags removed. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * The same URL with `www.` added or removed.
 *
 * Returns null when the host is not a plain `www`/apex pair, so this never
 * mangles a subdomain like `shop.example.com`.
 */
export function toggleWww(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.startsWith('www.')) {
      parsed.hostname = host.slice(4);
    } else if (host.split('.').length === 2) {
      parsed.hostname = `www.${host}`;
    } else {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Canonical start URL for a domain, preferring https. */
export function startUrlFor(domain: string, knownUrl?: string | null): string {
  if (knownUrl !== null && knownUrl !== undefined && knownUrl !== '') {
    try {
      return canonicalize(knownUrl);
    } catch {
      // Fall through to the constructed form.
    }
  }
  return `https://${domain}`;
}
