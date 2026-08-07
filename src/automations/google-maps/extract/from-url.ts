/**
 * The URL extraction channel.
 *
 * A Maps place URL encodes the business's identity and coordinates directly.
 * This channel cannot break the way a CSS selector or an XHR array index can —
 * the URL format is a public contract that other Google products depend on — so
 * it is the foundation the other channels are merged onto.
 *
 * This is also what the legacy system threw away. Its output had no CID on 126
 * of 438 rows and 50 byte-identical duplicates, because without a stable key
 * there is nothing to deduplicate on.
 *
 * A typical URL:
 *   /maps/place/Acme+Plumbing/@33.748,-84.395,17z/data=!3m1!4b1!4m6!3m5!
 *     1s0x88f5047:0xc2f04514d1d4262b!8m2!3d33.748!4d-84.395!16s%2Fg%2F11abc
 */

/** Everything the URL alone can tell us. */
export interface UrlExtraction {
  /** Decimal CID as a string — see {@link cidFromFid} for why not a number. */
  readonly cid: string | null;
  /** Hex feature id, `0x<hex>:0x<hex>`. */
  readonly fid: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly zoom: number | null;
  /** The `!16s/g/...` knowledge-graph id, when present. */
  readonly kgmid: string | null;
  /** Business name as it appears in the path, best-effort. */
  readonly nameHint: string | null;
}

/**
 * `!1s0x<hex>:0x<hex>` — the feature id.
 *
 * The `!1s` prefix is part of Google's protobuf-ish URL encoding. Matching the
 * hex pair directly rather than parsing the whole structure keeps this robust
 * against unrelated fields being added or reordered.
 */
const FID_PATTERN = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;

/** A bare fid can also appear in `?ftid=` or as a `data=` fragment. */
const FID_FALLBACK = /\b(0x[0-9a-f]{6,}:0x[0-9a-f]{6,})\b/i;

/** `!8m2!3d<lat>!4d<lng>` — the place's own coordinates. */
const PLACE_COORDS = /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/;

/** `@<lat>,<lng>,<zoom>z` — the *viewport*, which is not the place. */
const VIEWPORT_COORDS = /@(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+\.?\d*)z/;

/** `!16s%2Fg%2F11abc` — knowledge graph id. */
const KGMID = /!16s(%2F|\/)([a-z])(%2F|\/)([a-z0-9_]+)/i;

/**
 * Convert the hex feature id to a decimal CID.
 *
 * The CID is the *second* half of the fid. It is an unsigned 64-bit integer, so
 * it must go through BigInt: `Number('0xc2f04514d1d4262b')` is 14047229432529182000
 * — wrong from the 17th digit — and `parseInt` on the same value silently loses
 * precision too. The result is returned as a string so it cannot be re-corrupted
 * by JSON, CSV, or a spreadsheet downstream.
 */
export function cidFromFid(fid: string): string | null {
  const parts = fid.split(':');
  if (parts.length !== 2) return null;
  const hex = parts[1];
  if (hex === undefined || !/^0x[0-9a-f]+$/i.test(hex)) return null;
  try {
    return BigInt(hex).toString(10);
  } catch {
    return null;
  }
}

/** Extract everything the URL encodes. Pure; safe on a malformed URL. */
export function extractFromUrl(url: string): UrlExtraction {
  const empty: UrlExtraction = {
    cid: null,
    fid: null,
    lat: null,
    lng: null,
    zoom: null,
    kgmid: null,
    nameHint: null,
  };
  if (typeof url !== 'string' || url === '') return empty;

  // Decode once so percent-encoded delimiters inside `data=` are matchable.
  // Some URLs are double-encoded; a failed decode just means we match the raw
  // form, which is still usually enough.
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed escape sequence — keep the original.
  }

  const fidMatch = FID_PATTERN.exec(decoded) ?? FID_FALLBACK.exec(decoded);
  const fid = fidMatch?.[1]?.toLowerCase() ?? null;

  // An explicit ?cid= wins: it is unambiguous and needs no derivation.
  let cid: string | null = null;
  const explicitCid = /[?&](?:cid|ludocid)=(\d+)/.exec(url);
  if (explicitCid?.[1] !== undefined) cid = explicitCid[1];
  else if (fid !== null) cid = cidFromFid(fid);

  // Place coordinates first; the @ viewport is where the map was centred, which
  // may be some distance from the business itself.
  let lat: number | null = null;
  let lng: number | null = null;
  const place = PLACE_COORDS.exec(decoded);
  const viewport = VIEWPORT_COORDS.exec(decoded);
  if (place !== null) {
    lat = toCoord(place[1]);
    lng = toCoord(place[2]);
  } else if (viewport !== null) {
    lat = toCoord(viewport[1]);
    lng = toCoord(viewport[2]);
  }

  const kg = KGMID.exec(decoded);
  const kgmid = kg !== null ? `/${kg[2]}/${kg[4]}` : null;

  return {
    cid,
    fid,
    lat,
    lng,
    zoom: viewport !== null ? toCoord(viewport[3]) : null,
    kgmid,
    nameHint: nameFromPath(url),
  };
}

function toCoord(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The business name from `/maps/place/<Name>/...`.
 *
 * A hint only. It is URL-slugged (`+` for spaces, punctuation mangled), so it is
 * used to cross-check the extracted name rather than as the name itself.
 */
function nameFromPath(url: string): string | null {
  const match = /\/maps\/place\/([^/@]+)/.exec(url);
  const raw = match?.[1];
  if (raw === undefined || raw === '') return null;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Whether a URL is a Maps place page.
 *
 * Used to filter the feed's links: the results list also contains links to
 * directions, reviews and Google's own products.
 */
export function isPlaceUrl(url: string): boolean {
  return /\/maps\/place\//.test(url);
}

/**
 * A canonical, comparable form of a place URL.
 *
 * The feed re-renders as it scrolls and hands back the same place with different
 * tracking parameters, so URLs must be compared by identity rather than by
 * string. Prefers CID, then fid, then a normalized path.
 */
export function placeUrlKey(url: string): string | null {
  const { cid, fid } = extractFromUrl(url);
  if (cid !== null) return `cid:${cid}`;
  if (fid !== null) return `fid:${fid}`;
  const path = /\/maps\/place\/([^@]+)/.exec(url)?.[1];
  return path !== undefined ? `path:${path.replace(/\/+$/, '')}` : null;
}
