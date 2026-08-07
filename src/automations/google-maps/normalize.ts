/**
 * Normalization of scraped Google Maps fields.
 *
 * Everything here is pure and unit-tested, because these transforms are where
 * data quietly becomes wrong: a phone number that keeps its formatting cannot be
 * deduplicated, and a website URL that is not unwrapped points at google.com.
 */
import { parse as parseDomain } from 'tldts';
import { createHash } from 'node:crypto';

/**
 * Unwrap Google's redirect around an outbound link.
 *
 * The website field on a place page is **not** the business's URL. It is
 * `/url?q=http://realsite.com/&opi=...&usg=...`, and feeding that to the email
 * crawler would send every single request to google.com — a pipeline that looks
 * completely healthy while producing zero emails, because google.com always
 * responds and never contains the business's address.
 *
 * Returns the target URL, or the input unchanged when it is already direct.
 */
export function unwrapGoogleRedirect(input: string | null | undefined): string | null {
  if (input === null || input === undefined || input.trim() === '') return null;
  const raw = input.trim();

  let url: URL;
  try {
    url = new URL(raw, 'https://www.google.com');
  } catch {
    return null;
  }

  const isGoogleHost = /(^|\.)google\.[a-z.]+$/i.test(url.hostname);
  if (isGoogleHost && (url.pathname === '/url' || url.pathname === '/aclk')) {
    // Google has used several names for the destination parameter.
    for (const key of ['q', 'url', 'u', 'adurl']) {
      const target = url.searchParams.get(key);
      if (target !== null && target !== '') {
        // The target is itself sometimes a redirect (rare, but it happens).
        return unwrapGoogleRedirect(target);
      }
    }
    return null;
  }

  return raw;
}

/** Tracking parameters that identify the referrer rather than the page. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  '_ga',
  'yclid',
]);

/**
 * Canonicalize a business website URL.
 *
 * Strips tracking parameters and the fragment, lowercases the host, and drops a
 * trailing slash on the root, so the same site reached from two listings
 * produces one domain row rather than two.
 */
export function normalizeWebsiteUrl(input: string | null | undefined): string | null {
  const unwrapped = unwrapGoogleRedirect(input);
  if (unwrapped === null) return null;

  let url: URL;
  try {
    url = new URL(unwrapped.startsWith('http') ? unwrapped : `http://${unwrapped}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || !url.hostname.includes('.')) return null;

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  const text = url.toString();
  return url.pathname === '/' && url.search === '' ? text.replace(/\/$/, '') : text;
}

/**
 * Hosts that are a social profile or a Google property, not a business website.
 *
 * Crawling facebook.com for a business's email finds Facebook's, and a listing
 * whose "website" is a Google property has no real site at all.
 */
const NON_WEBSITE_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
  'yelp.com',
  'google.com',
  'business.site',
  'sites.google.com',
  'goo.gl',
  'maps.app.goo.gl',
]);

export interface DomainInfo {
  /** Registrable domain, lowercased, no `www`. */
  readonly domain: string;
  /** A social or aggregator profile rather than the business's own site. */
  readonly isSocial: boolean;
}

/**
 * The registrable domain of a website URL.
 *
 * Uses the public suffix list rather than "last two labels", which gets
 * `acme.co.uk` and `acme.github.io` wrong — and those errors would merge
 * unrelated businesses into one domain crawl.
 */
export function domainOf(websiteUrl: string | null | undefined): DomainInfo | null {
  if (websiteUrl === null || websiteUrl === undefined || websiteUrl === '') return null;

  const parsed = parseDomain(websiteUrl);
  const domain = parsed.domain?.toLowerCase();
  if (domain === undefined || domain === null || domain === '') return null;

  return { domain, isSocial: NON_WEBSITE_DOMAINS.has(domain) };
}

/**
 * A US phone number in E.164.
 *
 * Deliberately US-only: the seed data is US-only and is kept that way for
 * GDPR reasons, so pulling in libphonenumber (several hundred KB of metadata for
 * every country) would be cost without benefit. A non-US number returns null
 * rather than being silently mangled into a wrong `+1`.
 */
export function toE164(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;

  const trimmed = input.trim();
  if (trimmed === '') return null;

  // An already-international number that is not +1 is out of scope.
  if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) return null;

  const digits = trimmed.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;

  // NANP: area code and exchange both start 2-9. This rejects the placeholder
  // and partially-parsed values that otherwise look plausible.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;

  return `+1${national}`;
}

export interface AddressParts {
  readonly street: string | null;
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

/**
 * Split a US address string into components.
 *
 * Google's format is reliably `street, city, ST 12345`, so this parses from the
 * right, where the shape is most predictable. Anything it cannot place stays in
 * `address_raw`, which is always kept — a half-parsed address is worse than an
 * unparsed one.
 */
export function parseUsAddress(input: string | null | undefined): AddressParts {
  const empty: AddressParts = {
    street: null,
    city: null,
    stateCode: null,
    postalCode: null,
    country: null,
  };
  if (input === null || input === undefined || input.trim() === '') return empty;

  const cleaned = input.replace(/\s+/g, ' ').trim();
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return empty;

  let country: string | null = null;
  if (parts.length > 1 && /^(USA|United States)$/i.test(parts.at(-1) ?? '')) {
    country = 'US';
    parts.pop();
  }

  // The last remaining part should be "ST 12345" or "ST 12345-6789".
  const tail = parts.at(-1) ?? '';
  const stateZip = /^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(tail);

  if (stateZip !== null) {
    parts.pop();
    return {
      stateCode: stateZip[1] ?? null,
      postalCode: stateZip[2] ?? null,
      city: parts.length > 0 ? (parts.pop() ?? null) : null,
      street: parts.length > 0 ? parts.join(', ') : null,
      country: country ?? 'US',
    };
  }

  // No recognizable state+zip: keep the street, leave the rest null rather than
  // guessing which comma-separated fragment is the city.
  return { ...empty, street: cleaned, country };
}

/**
 * The key a business is deduplicated on.
 *
 * CID when available. Otherwise a hash of the name, phone and coordinates
 * rounded to ~11m — close enough that the same business seen from two searches
 * collapses, far enough apart that neighbouring businesses do not.
 *
 * Every business gets one, which is what lets the ~30% of listings with no CID
 * still deduplicate instead of accumulating as the legacy system's 50
 * byte-identical rows did.
 */
export function dedupHash(input: {
  cid?: string | null;
  name: string;
  phoneE164?: string | null;
  lat?: number | null;
  lng?: number | null;
}): string {
  if (input.cid !== null && input.cid !== undefined && input.cid !== '') {
    return `cid:${input.cid}`;
  }

  const parts = [
    input.name.trim().toLowerCase().replace(/\s+/g, ' '),
    input.phoneE164 ?? '',
    input.lat !== null && input.lat !== undefined ? input.lat.toFixed(4) : '',
    input.lng !== null && input.lng !== undefined ? input.lng.toFixed(4) : '',
  ];

  return `h:${createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}

/** Parse a rating like `4.5` from text or an aria-label. */
export function parseRating(input: string | number | null | undefined): number | null {
  if (typeof input === 'number') return input >= 0 && input <= 5 ? input : null;
  if (input === null || input === undefined) return null;
  const match = /(\d+(?:[.,]\d+)?)/.exec(input);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
}

/** Parse a review count from `1,234 reviews` or `(1,234)`. */
export function parseReviewCount(input: string | number | null | undefined): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input >= 0 ? input : null;
  if (input === null || input === undefined) return null;
  const match = /([\d,.\u00a0\u202f]+)/.exec(input);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1].replace(/[,.\u00a0\u202f]/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
