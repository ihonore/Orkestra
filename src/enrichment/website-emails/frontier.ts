/**
 * The link frontier: which page to fetch next.
 *
 * The legacy crawler picked links **at random** (`randomize: true`, depth 1, max
 * 5 pages). Contact and About pages were found by luck. With a five-page budget
 * and random selection over a typical 60-link navigation, the odds of reaching
 * `/contact` are poor — which is why so many of its rows said "No email found"
 * for businesses that plainly publish an address.
 *
 * Scoring instead means the five pages fetched are the five most likely to hold
 * an address, and the budget goes much further.
 */

export interface ScoredLink {
  readonly url: string;
  readonly score: number;
  readonly depth: number;
}

/**
 * Path or anchor keywords that indicate a contact-bearing page, in English
 * and French. "contact" already covers nous-contacter and contactez-nous.
 * French law requires every business site to publish "mentions légales" with
 * the publisher's contact details, which makes it the surest page there is.
 */
const CONTACT_KEYWORDS =
  /(contact|contact-us|contactus|about|about-us|aboutus|team|our-team|staff|people|meet|impressum|kontakt|support|reach|connect|get-in-touch|enquir|inquir|mentions|propos|qui-sommes|equipe|infos-pratiques|nous-trouver|rendez-vous)/i;

/** Sections that are long, numerous, and almost never hold a contact address. */
const LOW_VALUE_PATHS =
  /(\/blog|\/news|\/article|\/post|\/product|\/shop|\/store|\/cart|\/checkout|\/category|\/tag|\/archive|\/event|\/gallery|\/portfolio|\/case-stud|\/\d{4}\/\d{2})/i;

/** Pagination: unbounded, and each page is a near-duplicate of the last. */
const PAGINATION = /([?&]page=|\/page\/\d+|[?&]p=\d+|[?&]offset=)/i;

/** Assets and machine endpoints. */
const NON_PAGE =
  /(\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|json|xml|pdf|zip|mp4|mp3|woff2?|ttf)($|\?)|\/wp-content\/|\/wp-json\/|\/feed\/?$|\/rss)/i;

/** Legal pages: low yield, but they do sometimes carry a contact address. */
const LEGAL = /(privacy|terms|legal|disclaimer|cookie|cgv|confidentialite)/i;

export interface ScoreOptions {
  readonly depth?: number;
  readonly anchorText?: string;
  readonly inNavOrFooter?: boolean;
}

/**
 * Score a candidate link. Higher is fetched sooner.
 *
 * The weights encode a simple belief: a link whose path or anchor text says
 * "contact" is worth far more than anything else, depth is a real cost, and
 * blog/product/pagination URLs are worth actively avoiding because they consume
 * the whole budget while yielding nothing.
 */
export function scoreLink(url: string, options: ScoreOptions = {}): number {
  const depth = options.depth ?? 1;
  let score = 0;

  // The entry point always goes first. Without this a *guessed* `/contact`
  // (score 4.5) outranks the landing page (score 0), so the crawl's first
  // request is a URL that may well not exist — and a 404 there was being read
  // as "this site is dead". That misfired on 12 of 40 real domains.
  if (depth === 0) return 100;

  let path = url;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    // Score the raw string if it will not parse.
  }

  if (CONTACT_KEYWORDS.test(path)) score += 5;
  if (options.anchorText !== undefined && CONTACT_KEYWORDS.test(options.anchorText)) score += 3;
  if (options.inNavOrFooter === true) score += 1;
  if (LEGAL.test(path)) score += 1.5;

  score -= 1.5 * depth;

  if (LOW_VALUE_PATHS.test(path)) score -= 2;
  if (PAGINATION.test(path)) score -= 3;
  if (NON_PAGE.test(path)) score -= 5;

  // Deep paths are usually content, not contact details.
  const segments = path.split('/').filter((s) => s !== '').length;
  if (segments > 3) score -= 0.5 * (segments - 3);

  const queryCount = (path.match(/[?&]/g) ?? []).length;
  if (queryCount > 1) score -= 2;

  return score;
}

/**
 * A bounded, deduplicating priority queue of URLs for one domain.
 *
 * Not a full sort on every push: the queue is small (hundreds at most) and
 * `take()` scans for the maximum, which is cheaper than maintaining a heap at
 * this size and much easier to reason about.
 */
export class LinkFrontier {
  readonly #queue = new Map<string, ScoredLink>();
  readonly #visited = new Set<string>();

  constructor(
    private readonly options: {
      readonly maxDepth: number;
      /** Same registrable domain only, unless this is true. */
      readonly followSubdomains?: boolean;
      readonly siteDomain: string;
      /**
       * The host the crawl starts on, which is on-site even when it is a
       * subdomain (paris.monsalon.fr for monsalon.fr): otherwise the start
       * page itself is refused and the site yields nothing.
       */
      readonly startHost?: string;
    },
  ) {}

  get size(): number {
    return this.#queue.size;
  }

  get visitedCount(): number {
    return this.#visited.size;
  }

  hasVisited(url: string): boolean {
    return this.#visited.has(canonicalize(url));
  }

  markVisited(url: string): void {
    const key = canonicalize(url);
    this.#visited.add(key);
    this.#queue.delete(key);
  }

  /**
   * Offer a link to the queue.
   *
   * Rejected when off-site, already seen, too deep, or an obvious non-page.
   * Returns whether it was accepted, which the caller uses for diagnostics.
   */
  offer(url: string, options: ScoreOptions = {}): boolean {
    const depth = options.depth ?? 1;
    if (depth > this.options.maxDepth) return false;

    let normalized: string;
    try {
      normalized = canonicalize(url);
    } catch {
      return false;
    }
    if (this.#visited.has(normalized) || this.#queue.has(normalized)) return false;
    if (!this.#onSite(normalized)) return false;
    if (NON_PAGE.test(normalized)) return false;

    this.#queue.set(normalized, { url: normalized, score: scoreLink(normalized, options), depth });
    return true;
  }

  /** Remove and return the highest-scoring link. */
  take(): ScoredLink | null {
    let best: ScoredLink | null = null;
    for (const link of this.#queue.values()) {
      if (best === null || link.score > best.score) best = link;
    }
    if (best === null) return null;
    this.#queue.delete(best.url);
    this.#visited.add(best.url);
    return best;
  }

  #onSite(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const site = this.options.siteDomain.toLowerCase().replace(/^www\./, '');
      const start = this.options.startHost?.toLowerCase().replace(/^www\./, '');
      if (start !== undefined && host === start) return true;
      return this.options.followSubdomains === true ? host.endsWith(site) : host === site;
    } catch {
      return false;
    }
  }
}

/** Tracking parameters that make the same page look like many. */
const STRIP_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_|_ga|ref|referrer|yclid)/i;

/**
 * Canonical form of a URL for deduplication.
 *
 * Drops the fragment and tracking parameters, lowercases the host, and removes a
 * trailing slash, so `/contact`, `/contact/` and `/contact?utm_source=x` are one
 * page rather than three fetches out of a five-page budget.
 */
export function canonicalize(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  for (const key of [...parsed.searchParams.keys()]) {
    if (STRIP_PARAMS.test(key)) parsed.searchParams.delete(key);
  }

  let text = parsed.toString();
  if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
    text = text.replace(`${parsed.pathname}`, parsed.pathname.slice(0, -1));
  }
  return text.replace(/\/$/, '');
}

/**
 * Extract links from HTML with their anchor text and position.
 *
 * Anchor text matters: a link labelled "Contact us" pointing at `/c/` is
 * invisible to path matching alone.
 */
export function extractLinks(
  html: string,
  baseUrl: string,
): { url: string; anchorText: string; inNavOrFooter: boolean }[] {
  const links: { url: string; anchorText: string; inNavOrFooter: boolean }[] = [];

  // Which byte ranges are inside a nav or footer, so position can be scored.
  const navRanges: [number, number][] = [];
  for (const match of html.matchAll(/<(nav|footer)\b[\s\S]*?<\/\1>/gi)) {
    if (match.index !== undefined) navRanges.push([match.index, match.index + match[0].length]);
  }

  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi,
  )) {
    const href = match[1];
    if (href === undefined) continue;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;

    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const position = match.index ?? 0;
    links.push({
      url: absolute,
      anchorText: (match[2] ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      inNavOrFooter: navRanges.some(([start, end]) => position >= start && position < end),
    });
  }

  return links;
}

/**
 * Contact-page URLs worth trying directly.
 *
 * Many sites have `/contact` without linking to it from the homepage in a way
 * this crawler can see (a JavaScript menu, for instance). Guessing a handful of
 * conventional paths is one cheap request each and frequently the whole job.
 */
export const COMMON_CONTACT_PATHS: readonly string[] = [
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
];
