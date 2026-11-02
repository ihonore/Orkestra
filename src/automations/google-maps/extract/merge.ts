/**
 * Three-channel merge and the selector-rot health guard.
 *
 * Each field is taken from the first channel that supplies it, in configured
 * priority order, and *which* channel won is recorded per field. That record is
 * what makes rot diagnosable: when the website fill rate falls, provenance says
 * whether the XHR shape moved or the DOM did, which is the difference between a
 * five-minute fix and an afternoon of guessing.
 *
 * The health guard exists because of how the legacy system failed. It had no
 * fill-rate monitoring, so when extraction broke it wrote thousands of rows of
 * nulls and looked like it was working. **Aborting a run loudly is strictly
 * better than completing it with empty data** — the run can be restarted, but
 * nobody re-checks 40,000 rows that already look finished.
 */
import type { DomExtraction } from './from-dom.js';
import type { UrlExtraction } from './from-url.js';
import type { XhrExtraction } from './from-xhr.js';
import {
  domainOf,
  normalizeWebsiteUrl,
  parseRating,
  parseReviewCount,
  parseUsAddress,
  toE164,
  dedupHash,
} from '../normalize.js';

export type Channel = 'url' | 'xhr' | 'dom';

/** Which channel supplied each field. Stored as `businesses.extraction_source`. */
export type Provenance = Partial<Record<keyof MergedBusiness, Channel>>;

export interface MergedBusiness {
  readonly cid: string | null;
  readonly fid: string | null;
  readonly placeId: string | null;
  readonly name: string | null;
  readonly categoryPrimary: string | null;
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
  readonly domain: string | null;
  readonly domainIsSocial: boolean;
  readonly rating: number | null;
  readonly reviewsCount: number | null;
  readonly thumbnailUrl: string | null;
  readonly hoursJson: string | null;
  readonly permanentlyClosed: boolean;
  readonly gmapsUrl: string | null;
}

export interface MergeInput {
  readonly url: UrlExtraction;
  readonly xhr: XhrExtraction;
  readonly dom: DomExtraction;
  readonly gmapsUrl: string;
  /** Channel priority, highest first. */
  readonly channels?: readonly Channel[];
}

export interface MergeResult {
  readonly business: MergedBusiness;
  readonly provenance: Provenance;
  readonly dedupHash: string;
}

const DEFAULT_CHANNELS: readonly Channel[] = ['xhr', 'dom', 'url'];

/**
 * First *usable* candidate, with the channel that supplied it.
 *
 * `isValid` is what makes this robust. Without it, a higher-priority channel
 * that returns something structurally plausible but semantically wrong blocks a
 * lower-priority channel holding the correct value — and the field ends up null
 * even though it was available.
 *
 * This is not hypothetical: on a live Birmingham search the XHR channel offered
 * `-8608314605215539785` as a phone number (a negative 64-bit id that matches
 * any loose phone pattern) while the DOM held a perfectly good
 * `+12052360125`. Phone fill was 0% until validation was added here.
 */
function pick<T>(
  order: readonly Channel[],
  candidates: Partial<Record<Channel, T | null | undefined>>,
  isValid?: (value: T) => boolean,
): { value: T | null; channel: Channel | null } {
  for (const channel of order) {
    const value = candidates[channel];
    if (value === null || value === undefined || value === '') continue;
    if (isValid !== undefined && !isValid(value)) continue;
    return { value, channel };
  }
  return { value: null, channel: null };
}

export function mergeExtractions(input: MergeInput): MergeResult {
  const order = input.channels ?? DEFAULT_CHANNELS;
  const provenance: Provenance = {};

  const take = <T>(
    field: keyof MergedBusiness,
    candidates: Partial<Record<Channel, T | null | undefined>>,
    isValid?: (value: T) => boolean,
    fieldOrder: readonly Channel[] = order,
  ): T | null => {
    const { value, channel } = pick(fieldOrder, candidates, isValid);
    if (channel !== null) provenance[field] = channel;
    return value;
  };

  // Identity: the URL channel is authoritative and cannot rot, so it wins here
  // regardless of the configured order.
  const cid = input.url.cid ?? input.xhr.cid ?? null;
  if (cid !== null) provenance.cid = input.url.cid !== null ? 'url' : 'xhr';

  const fid = input.url.fid;
  if (fid !== null) provenance.fid = 'url';

  // Name and website come from the open listing first. The panel shows exactly
  // one business — the one being scraped — while network traffic can be about
  // any place the page loaded. With XHR first, every name in the database came
  // from XHR, and 1,537 of 9,457 were another place's. XHR is still the
  // fallback, now restricted to the target's own record.
  const panelFirst: readonly Channel[] = ['dom', 'xhr', 'url'];

  const name = take<string>(
    'name',
    {
      xhr: input.xhr.name,
      dom: input.dom.name,
      url: input.url.nameHint,
    },
    undefined,
    panelFirst,
  );

  // Only accept a phone that actually normalizes. See {@link pick}.
  const phoneRaw = take<string>(
    'phoneRaw',
    { xhr: input.xhr.phone, dom: input.dom.phone },
    (value) => toE164(value) !== null,
  );
  // An address must at least contain a digit and a comma; the XHR channel
  // otherwise offers category names and opaque ids that look address-shaped.
  const addressRaw = take<string>(
    'addressRaw',
    { xhr: input.xhr.address, dom: input.dom.address },
    (value) => /\d/.test(value) && value.includes(','),
  );

  // The website is unwrapped before anything downstream sees it. Skipping this
  // sends the whole email stage to google.com.
  const websiteRaw = take<string>(
    'websiteRaw',
    { xhr: input.xhr.website, dom: input.dom.website },
    undefined,
    panelFirst,
  );
  const websiteUrl = normalizeWebsiteUrl(websiteRaw);
  const domainInfo = domainOf(websiteUrl);

  const lat = take<number>('lat', { url: input.url.lat, xhr: input.xhr.lat });
  const lng = take<number>('lng', { url: input.url.lng, xhr: input.xhr.lng });

  const rating = take<number>('rating', {
    xhr: input.xhr.rating,
    dom: parseRating(input.dom.rating),
  });
  const reviewsCount = take<number>('reviewsCount', {
    xhr: input.xhr.reviews,
    dom: parseReviewCount(input.dom.reviews),
  });

  const address = parseUsAddress(addressRaw);
  const phoneE164 = toE164(phoneRaw);

  const business: MergedBusiness = {
    cid,
    fid,
    placeId: input.xhr.placeId,
    name,
    categoryPrimary: take<string>('categoryPrimary', {
      xhr: input.xhr.categoryPrimary,
      dom: input.dom.categoryPrimary,
    }),
    phoneRaw,
    phoneE164,
    addressRaw,
    street: address.street,
    city: address.city,
    stateCode: address.stateCode,
    postalCode: address.postalCode,
    country: address.country,
    lat,
    lng,
    plusCode: input.dom.plusCode,
    websiteRaw,
    websiteUrl,
    domain: domainInfo?.domain ?? null,
    domainIsSocial: domainInfo?.isSocial ?? false,
    rating,
    reviewsCount,
    thumbnailUrl: input.dom.thumbnail,
    hoursJson: input.dom.hours,
    permanentlyClosed: input.xhr.permanentlyClosed ?? input.dom.permanentlyClosed,
    gmapsUrl: input.gmapsUrl,
  };

  return {
    business,
    provenance,
    dedupHash: dedupHash({
      cid,
      name: name ?? 'unknown',
      phoneE164,
      lat,
      lng,
    }),
  };
}

/** Fields whose fill rate is worth watching. */
export const TRACKED_FIELDS = [
  'cid',
  'name',
  'addressRaw',
  'phoneRaw',
  'websiteUrl',
  'rating',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/**
 * Running fill-rate tally for one run.
 *
 * Per-field null rates are a first-class deliverable, not observability polish:
 * they are the only thing standing between a silent schema change and 40,000
 * blank website rows.
 */
export class FillRateTracker {
  #total = 0;
  readonly #filled = new Map<TrackedField, number>();
  readonly #byChannel = new Map<string, number>();

  record(result: MergeResult): void {
    this.#total += 1;
    for (const field of TRACKED_FIELDS) {
      const value = result.business[field];
      if (value !== null && value !== undefined && value !== '') {
        this.#filled.set(field, (this.#filled.get(field) ?? 0) + 1);
      }
    }
    for (const [field, channel] of Object.entries(result.provenance)) {
      const key = `${field}:${String(channel)}`;
      this.#byChannel.set(key, (this.#byChannel.get(key) ?? 0) + 1);
    }
  }

  get sampleSize(): number {
    return this.#total;
  }

  rate(field: TrackedField): number {
    if (this.#total === 0) return 1;
    return (this.#filled.get(field) ?? 0) / this.#total;
  }

  rates(): Record<TrackedField, number> {
    return Object.fromEntries(TRACKED_FIELDS.map((f) => [f, this.rate(f)])) as Record<
      TrackedField,
      number
    >;
  }

  /** Per-field channel attribution, for diagnosing which channel rotted. */
  channelBreakdown(): Record<string, number> {
    return Object.fromEntries(this.#byChannel);
  }
}

export interface HealthGuardOptions {
  /** Minimum acceptable fill rate for `name`. */
  readonly minNameFillRate?: number;
  /** Minimum acceptable fill rate for `cid`. */
  readonly minCidFillRate?: number;
  /** Listings to see before the guard may fire. */
  readonly sampleSize?: number;
}

export interface HealthVerdict {
  readonly healthy: boolean;
  readonly reason: string | null;
  readonly rates: Record<TrackedField, number>;
}

/**
 * Decide whether extraction is still working.
 *
 * Only `name` and `cid` are hard gates. Phone, website and rating are legitimately
 * absent for many real businesses — a plumber with no website is not a bug — so
 * gating on those would abort healthy runs. A missing *name*, by contrast, means
 * the panel did not parse at all.
 */
export function checkHealth(
  tracker: FillRateTracker,
  options: HealthGuardOptions = {},
): HealthVerdict {
  const rates = tracker.rates();
  const sampleSize = options.sampleSize ?? 20;

  // Too early to judge: a handful of genuinely odd listings would otherwise
  // abort a healthy run in its first seconds.
  if (tracker.sampleSize < sampleSize) {
    return { healthy: true, reason: null, rates };
  }

  const minName = options.minNameFillRate ?? 0.95;
  if (rates.name < minName) {
    return {
      healthy: false,
      reason:
        `name fill rate ${(rates.name * 100).toFixed(1)}% is below ${(minName * 100).toFixed(0)}% ` +
        `over ${tracker.sampleSize} listings — extraction is probably broken`,
      rates,
    };
  }

  const minCid = options.minCidFillRate ?? 0.9;
  if (rates.cid < minCid) {
    return {
      healthy: false,
      reason:
        `CID fill rate ${(rates.cid * 100).toFixed(1)}% is below ${(minCid * 100).toFixed(0)}% ` +
        `over ${tracker.sampleSize} listings — without CIDs results cannot be deduplicated`,
      rates,
    };
  }

  return { healthy: true, reason: null, rates };
}
