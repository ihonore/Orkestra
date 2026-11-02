/**
 * The XHR extraction channel.
 *
 * Maps fetches its place data as deeply nested JSON arrays with no field names —
 * values are addressed purely by position. That is fragile in a specific and
 * dangerous way, and the honest framing matters:
 *
 * A rotted **CSS selector throws**; a rotted **array index returns null**. The
 * XHR channel changes less often, but when it does it fails silently, and the
 * result is tens of thousands of rows with a blank website — which is the sole
 * input to the entire email stage.
 *
 * Two consequences shape this file:
 *  - every read goes through {@link at}, a total function that returns undefined
 *    rather than throwing, so one moved index cannot abort a whole job;
 *  - the merge layer records which channel supplied each field, so a fill-rate
 *    drop can be attributed rather than guessed at.
 */

/** Endpoints that carry place data. Matched loosely — Google renames these. */
const PLACE_ENDPOINTS = [
  '/maps/preview/place',
  '/maps/preview/entity',
  '/search?tbm=map',
  '/maps/preview/search',
  '/locationhistory/preview/mas',
];

export function isPlaceEndpoint(url: string): boolean {
  return PLACE_ENDPOINTS.some((path) => url.includes(path));
}

/**
 * Strip Google's anti-JSON-hijacking prefix and parse.
 *
 * Responses begin with `)]}'` on its own line, which is not valid JSON. Some
 * endpoints also wrap the payload in a leading `[[` array that must be kept.
 */
export function parseXhrBody(body: string): unknown {
  if (typeof body !== 'string' || body.length === 0) return null;

  let text = body.trimStart();
  if (text.startsWith(")]}'")) text = text.slice(4);
  text = text.replace(/^\s*\n/, '').trim();
  if (text === '') return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read a nested path from an unknown value without ever throwing.
 *
 * `at(data, 6, 178, 0)` returns undefined if any hop is missing or the shape
 * changed. This is the *only* way this file touches the payload.
 */
export function at(value: unknown, ...path: readonly (number | string)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface XhrExtraction {
  readonly name: string | null;
  readonly placeId: string | null;
  readonly cid: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly categoryPrimary: string | null;
  readonly rating: number | null;
  readonly reviews: number | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly permanentlyClosed: boolean | null;
}

const EMPTY: XhrExtraction = {
  name: null,
  placeId: null,
  cid: null,
  address: null,
  phone: null,
  website: null,
  categoryPrimary: null,
  rating: null,
  reviews: null,
  lat: null,
  lng: null,
  permanentlyClosed: null,
};

/** The place a payload must describe for its fields to be used. */
export interface PlaceIdentity {
  readonly fid: string | null;
  readonly cid: string | null;
}

/** The feature id held directly in this array, if it is a place record. */
function directFid(node: unknown): string | null {
  if (!Array.isArray(node)) return null;
  const entries: unknown[] = node as unknown[];
  const fid = entries.find((entry) => typeof entry === 'string' && FID_RE.test(entry));
  return typeof fid === 'string' && entries.length > 5 ? fid.toLowerCase() : null;
}

function cidOfFid(fid: string): string | null {
  const hex = fid.split(':')[1];
  if (hex === undefined) return null;
  try {
    return BigInt(hex).toString(10);
  } catch {
    return null;
  }
}

/**
 * Every place record in a payload.
 *
 * Shape-matched rather than located by index path, which is exactly what rots:
 * an array whose own entries include a feature id. A place page's traffic
 * carries several — the place itself, plus nearby places, ads and "people also
 * search for" — so all are collected and the caller picks the right one.
 */
function findPlaceNodes(data: unknown, depth = 0, found: unknown[][] = []): unknown[][] {
  if (depth > 8 || !Array.isArray(data)) return found;
  const entries: unknown[] = data as unknown[];
  if (directFid(entries) !== null) found.push(entries);
  for (const child of entries) findPlaceNodes(child, depth + 1, found);
  return found;
}

function isTarget(node: unknown[], target: PlaceIdentity): boolean {
  const fid = directFid(node);
  if (fid === null) return false;
  if (target.fid !== null && fid === target.fid.toLowerCase()) return true;
  return target.cid !== null && cidOfFid(fid) === target.cid;
}

/**
 * Recursively collect the first value matching a predicate.
 *
 * Used for fields whose position genuinely varies between endpoints. It is
 * slower than indexing but cannot silently return the wrong field, because the
 * predicate validates the value's shape.
 */
function findFirst(
  data: unknown,
  predicate: (value: unknown) => boolean,
  ownFid: string | null = null,
  depth = 0,
  maxDepth = 10,
): unknown {
  if (depth > maxDepth || data === null || data === undefined) return undefined;
  if (predicate(data)) return data;
  if (!Array.isArray(data)) return undefined;
  for (const child of data) {
    // A nested record for a different place — a related listing inside this
    // one — holds that place's website and phone, not ours. Skip it whole.
    const childFid = directFid(child);
    if (ownFid !== null && childFid !== null && childFid !== ownFid) continue;
    const found = findFirst(child, predicate, ownFid, depth + 1, maxDepth);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Hosts that are Google's infrastructure, never a business's own site. The
 * old check named google.com and a few asset hosts, and missed the rest: 849
 * businesses had a Street View thumbnail on streetviewpixels-pa.googleapis.com
 * as their "website", and 51 an ad server.
 */
const GOOGLE_HOST_RE =
  /(^|\.)(google\.[a-z.]+|googleapis\.com|gstatic\.com|ggpht\.com|googleusercontent\.com|googlesyndication\.com|googleadservices\.com|doubleclick\.net|ytimg\.com|gvt1\.com|goo\.gl)$/i;

function isBusinessUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !URL_RE.test(value)) return false;
  try {
    return !GOOGLE_HOST_RE.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

const FID_RE = /^0x[0-9a-f]+:0x[0-9a-f]+$/i;
const PLACE_ID_RE = /^ChI[A-Za-z0-9_-]{10,}$/;
const URL_RE = /^https?:\/\//i;
/**
 * A plausible North American phone number.
 *
 * Anchored deliberately tightly. A looser pattern matches Google's negative
 * 64-bit ids (`-8608314605215539785`), which are abundant in these payloads and
 * would otherwise be offered as the phone number.
 */
const PHONE_RE = /^(?:\+1[\s-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}$/;

/**
 * Extract what a place payload contains.
 *
 * Every field is optional by construction. A payload whose shape has moved
 * yields nulls, the DOM channel fills the gap, and the health guard notices the
 * fill-rate drop — rather than the job throwing and the run stopping.
 */
export function extractFromXhr(payload: unknown, target?: PlaceIdentity): XhrExtraction {
  if (payload === null || payload === undefined) return EMPTY;

  // With a target, only its own record counts, and a payload about other
  // places contributes nothing. Without one (an unidentifiable page), the
  // first record is the best guess, as before.
  const nodes = findPlaceNodes(payload);
  const node: unknown =
    target !== undefined && (target.fid !== null || target.cid !== null)
      ? nodes.find((n) => isTarget(n, target))
      : (nodes[0] ?? payload);
  if (node === undefined) return EMPTY;
  const own = directFid(node);

  const fid = own ?? asString(findFirst(node, (v) => typeof v === 'string' && FID_RE.test(v)));
  const placeId = asString(
    findFirst(node, (v) => typeof v === 'string' && PLACE_ID_RE.test(v), own),
  );

  let cid: string | null = null;
  if (fid !== null) {
    const hex = fid.split(':')[1];
    if (hex !== undefined) {
      try {
        cid = BigInt(hex).toString(10);
      } catch {
        cid = null;
      }
    }
  }

  const website = asString(findFirst(node, isBusinessUrl, own));

  const phone = asString(
    findFirst(node, (v) => typeof v === 'string' && PHONE_RE.test(v) && /\d{7}/.test(v), own),
  );

  // Coordinates arrive as a [lat, lng] pair of plausible magnitude.
  const coords = findFirst(
    node,
    (v) => {
      if (!Array.isArray(v)) return false;
      const pair: unknown[] = v as unknown[];
      if (pair.length < 2) return false;
      const [a, b] = pair;
      return (
        typeof a === 'number' &&
        typeof b === 'number' &&
        Math.abs(a) <= 90 &&
        Math.abs(b) <= 180 &&
        // Reject [0,0] and integer pairs, which are almost always something else.
        !Number.isInteger(a) &&
        !Number.isInteger(b)
      );
    },
    own,
  );

  const rating = asNumber(
    findFirst(node, (v) => typeof v === 'number' && v > 0 && v <= 5 && !Number.isInteger(v), own),
  );

  return {
    name: asString(at(node, 11)) ?? asString(at(node, 1)),
    placeId,
    cid,
    address: asString(at(node, 39)) ?? asString(at(node, 18)),
    phone,
    website,
    categoryPrimary: asString(at(node, 13, 0)),
    rating,
    reviews: asNumber(at(node, 4, 8)),
    lat: Array.isArray(coords) ? asNumber(coords[0]) : null,
    lng: Array.isArray(coords) ? asNumber(coords[1]) : null,
    permanentlyClosed: null,
  };
}

/**
 * Collect place payloads seen during a navigation.
 *
 * Registered *before* navigating, because the payload arrives during load and a
 * listener attached afterwards misses it entirely.
 */
export class XhrCollector {
  readonly #payloads: unknown[] = [];

  get payloads(): readonly unknown[] {
    return this.#payloads;
  }

  get count(): number {
    return this.#payloads.length;
  }

  add(body: string): void {
    const parsed = parseXhrBody(body);
    if (parsed !== null) this.#payloads.push(parsed);
  }

  clear(): void {
    this.#payloads.length = 0;
  }

  /**
   * Best extraction across everything captured.
   *
   * Later payloads usually carry more detail, so they win, but a field only
   * gets overwritten by a non-null value — a later, thinner payload cannot
   * erase what an earlier one supplied.
   */
  best(target?: PlaceIdentity): XhrExtraction {
    let merged: XhrExtraction = EMPTY;
    for (const payload of this.#payloads) {
      const next = extractFromXhr(payload, target);
      merged = {
        name: next.name ?? merged.name,
        placeId: next.placeId ?? merged.placeId,
        cid: next.cid ?? merged.cid,
        address: next.address ?? merged.address,
        phone: next.phone ?? merged.phone,
        website: next.website ?? merged.website,
        categoryPrimary: next.categoryPrimary ?? merged.categoryPrimary,
        rating: next.rating ?? merged.rating,
        reviews: next.reviews ?? merged.reviews,
        lat: next.lat ?? merged.lat,
        lng: next.lng ?? merged.lng,
        permanentlyClosed: next.permanentlyClosed ?? merged.permanentlyClosed,
      };
    }
    return merged;
  }
}
