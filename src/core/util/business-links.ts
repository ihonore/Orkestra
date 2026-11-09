/**
 * Links that say something about a business beyond its website: its
 * Instagram profile, and the online-booking platform it takes appointments
 * through.
 *
 * Both the Maps scraper (the listing's "Book online" links and website field)
 * and the email crawler (links on the business's own site) report what they
 * see here, so the two cannot disagree about what counts as Planity.
 *
 * ## Where these come from on Maps
 *
 * Measured on Paris salons in November 2026: a listing that takes online
 * bookings carries one link per provider with Google's `rwg_token` parameter
 * ("Reserve with Google"), pointing at the provider's page for that salon —
 * planity.com, treatwell.fr, fresha.com — or at the salon's own booking page.
 * A salon's "website" is sometimes its Planity page itself, or a
 * `*.mytreatwell.fr` site Treatwell hosts for it.
 */
import { parse as parseDomain } from 'tldts';

/**
 * Booking platforms by registrable domain, with the name people know them by.
 *
 * A platform's own pages hold the platform's addresses, never the salon's, so
 * a website on one of these is not crawled for email (see `domainOf`).
 */
export const BOOKING_PLATFORMS: Readonly<Record<string, string>> = {
  'planity.com': 'Planity',
  'treatwell.fr': 'Treatwell',
  'treatwell.com': 'Treatwell',
  'treatwell.co.uk': 'Treatwell',
  'mytreatwell.fr': 'Treatwell',
  'fresha.com': 'Fresha',
  'booksy.com': 'Booksy',
  'iwana.fr': 'Iwana',
  'glaura.fr': 'Glaura',
  'kiute.com': 'Kiute',
  'salonkee.fr': 'Salonkee',
  'salonkee.com': 'Salonkee',
  'clicrdv.com': 'ClicRDV',
  'calendly.com': 'Calendly',
  'simplybook.me': 'SimplyBook',
  'simplybook.it': 'SimplyBook',
  'vagaro.com': 'Vagaro',
  // Found as salons' "websites" across Paris, November 2026. Each was shared
  // by several unrelated salons and so mistaken for a chain's site.
  'trea.tw': 'Treatwell',
  'uala.fr': 'Uala',
  'setmore.com': 'Setmore',
  'reservio.com': 'Reservio',
  'resalib.fr': 'Resalib',
  'sumupbookings.com': 'SumUp',
  'kalendes.com': 'Kalendes',
  'dybys.com': 'Dybys',
  'flexybeauty.com': 'Flexy',
  'bookinbeautiful.fr': 'Bookinbeautiful',
  'iddan.fr': 'Iddan',
  'dylentab.fr': 'Dylentab',
  'dikidi.net': 'Dikidi',
  'rdv360.com': 'RDV360',
  'smartbooker.fr': 'Smartbooker',
  'sur-rdv.com': 'Sur-rdv',
  'glaura.ai': 'Glaura',
  'wavy.fr': 'Wavy',
  'as.me': 'Acuity',
  'acuityscheduling.com': 'Acuity',
  'squareup.com': 'Square',
};

/** What a salon's online booking goes through when it is its own website. */
export const OWN_SITE_BOOKING = 'own site';

/** Instagram paths that are not a profile. */
const INSTAGRAM_NON_PROFILE = new Set([
  'p',
  'reel',
  'reels',
  'explore',
  'accounts',
  'stories',
  'tv',
  'direct',
  'about',
  'legal',
  'developer',
  'web',
  'share',
]);

function registrableDomain(url: URL): string | null {
  const domain = parseDomain(url.hostname).domain;
  return domain === null || domain === undefined ? null : domain.toLowerCase();
}

function parse(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The booking platform a domain belongs to, if it is one. */
export function bookingPlatformOf(domain: string | null | undefined): string | null {
  if (domain === null || domain === undefined) return null;
  return BOOKING_PLATFORMS[domain.toLowerCase()] ?? null;
}

/**
 * An Instagram profile URL in one canonical form, or null for anything else —
 * a post, a reel, the home page, a share link.
 */
export function instagramProfile(raw: string): string | null {
  const url = parse(raw);
  if (url === null || registrableDomain(url) !== 'instagram.com') return null;
  const handle = url.pathname.split('/').find((segment) => segment !== '');
  if (handle === undefined || INSTAGRAM_NON_PROFILE.has(handle.toLowerCase())) return null;
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
  return `https://www.instagram.com/${handle.toLowerCase()}/`;
}

export type LinkSignal =
  | { readonly kind: 'instagram'; readonly url: string }
  | { readonly kind: 'booking'; readonly provider: string; readonly url: string };

/**
 * What one link says about a business.
 *
 * `ownDomain` is the business's own website domain: a Google booking link
 * (`rwg_token`) to it means the salon books through its own site. A booking
 * link to an unknown third party is reported under that party's domain, so
 * a provider missing from {@link BOOKING_PLATFORMS} still shows up.
 */
export function classifyLink(raw: string, ownDomain: string | null = null): LinkSignal | null {
  const instagram = instagramProfile(raw);
  if (instagram !== null) return { kind: 'instagram', url: instagram };

  const url = parse(raw);
  if (url === null) return null;
  const domain = registrableDomain(url);
  const viaGoogle = url.searchParams.has('rwg_token');
  // The token identifies Google's referral, not the salon: drop it.
  url.searchParams.delete('rwg_token');
  const clean = url.toString();

  const platform = bookingPlatformOf(domain);
  if (platform !== null) return { kind: 'booking', provider: platform, url: clean };
  if (!viaGoogle || domain === null) return null;
  return {
    kind: 'booking',
    provider: ownDomain !== null && domain === ownDomain ? OWN_SITE_BOOKING : domain,
    url: clean,
  };
}

export interface BusinessSignals {
  readonly instagramUrl: string | null;
  /** Every provider found, platforms first, comma-separated: "Planity, Fresha". */
  readonly bookingProvider: string | null;
  readonly bookingUrl: string | null;
}

/**
 * Sum up every link seen for a business.
 *
 * A salon on several platforms lists them all, named platforms before its own
 * site, because the team's question is "is this salon already on Planity or
 * Treatwell?".
 */
export function signalsFrom(
  links: readonly (string | null | undefined)[],
  ownDomain: string | null = null,
): BusinessSignals {
  let instagramUrl: string | null = null;
  const providers = new Map<string, string>();
  for (const raw of links) {
    if (raw === null || raw === undefined || raw === '') continue;
    const signal = classifyLink(raw, ownDomain);
    if (signal === null) continue;
    if (signal.kind === 'instagram') instagramUrl ??= signal.url;
    else if (!providers.has(signal.provider)) providers.set(signal.provider, signal.url);
  }
  const named = [...providers.keys()].filter((p) => Object.values(BOOKING_PLATFORMS).includes(p));
  const others = [...providers.keys()].filter((p) => !named.includes(p));
  const ordered = [...named, ...others];
  const first = ordered[0];
  return {
    instagramUrl,
    bookingProvider: ordered.length > 0 ? ordered.join(', ') : null,
    bookingUrl: first === undefined ? null : (providers.get(first) ?? null),
  };
}

/**
 * Join booking-provider lists ("Planity, setmore.com") into one, naming any
 * provider stored by its domain before {@link BOOKING_PLATFORMS} knew it,
 * named platforms first, each once. Null when there are none.
 */
export function mergeProviders(...lists: readonly (string | null | undefined)[]): string | null {
  const providers = new Set<string>();
  for (const list of lists) {
    for (const token of (list ?? '').split(',')) {
      const provider = token.trim();
      if (provider !== '') providers.add(bookingPlatformOf(provider) ?? provider);
    }
  }
  const names = new Set(Object.values(BOOKING_PLATFORMS));
  const ordered = [
    ...[...providers].filter((p) => names.has(p)),
    ...[...providers].filter((p) => !names.has(p)),
  ];
  return ordered.length > 0 ? ordered.join(', ') : null;
}

/**
 * Whether text says the business works by appointment only.
 *
 * Maps does not expose this for French listings, so it comes from the
 * business's name ("Barbier sur RDV") and its own site.
 */
export function saysByAppointment(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  return /\b(?:sur|uniquement sur|exclusivement sur|que sur)\s+(?:rdv|r\.d\.v|rendez[\s-]?vous)\b|\bby appointment only\b|\bappointment only\b/i.test(
    text,
  );
}
