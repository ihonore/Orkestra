import { describe, expect, it } from 'vitest';
import {
  cidFromFid,
  extractFromUrl,
  isPlaceUrl,
  placeUrlKey,
} from '../src/automations/google-maps/extract/from-url.js';
import {
  at,
  extractFromXhr,
  isPlaceEndpoint,
  parseXhrBody,
  XhrCollector,
} from '../src/automations/google-maps/extract/from-xhr.js';
import {
  FillRateTracker,
  checkHealth,
  mergeExtractions,
} from '../src/automations/google-maps/extract/merge.js';
import {
  dedupHash,
  domainOf,
  normalizeWebsiteUrl,
  parseRating,
  parseReviewCount,
  parseUsAddress,
  toE164,
  unwrapGoogleRedirect,
} from '../src/automations/google-maps/normalize.js';
import {
  DEFAULT_QUERY_TEMPLATE,
  buildQuery,
  buildSearchUrl,
} from '../src/automations/google-maps/search.js';
import type { DomExtraction } from '../src/automations/google-maps/extract/from-dom.js';

/** A real listing URL, captured live from a Birmingham plumber search. */
const REAL_URL =
  'https://www.google.com/maps/place/Mr.+Drippy+Plumbing/@33.4463309,-86.8386895,17z/data=!3m1!4b1!4m6!3m5!1s0x88891f79b1521db7:0xb4af8e008822f33a!8m2!3d33.4463309!4d-86.8386895!16s%2Fg%2F11c1q8_0k9?hl=en';

describe('URL channel', () => {
  it('extracts identity and coordinates from a real listing URL', () => {
    const result = extractFromUrl(REAL_URL);
    expect(result.fid).toBe('0x88891f79b1521db7:0xb4af8e008822f33a');
    expect(result.cid).toBe('13019781180686529338');
    expect(result.lat).toBeCloseTo(33.4463309, 5);
    expect(result.lng).toBeCloseTo(-86.8386895, 5);
    expect(result.nameHint).toBe('Mr. Drippy Plumbing');
  });

  it('derives CID through BigInt, because Number loses precision', () => {
    // The whole reason CID is stored as TEXT. Verified against a live listing.
    const cid = cidFromFid('0x88891f79b1521db7:0xb4af8e008822f33a');
    expect(cid).toBe('13019781180686529338');

    // Comparison must be against the *string*: writing the expected value as a
    // numeric literal would itself be rounded, so the assertion would pass
    // while proving nothing. Round-tripping through Number visibly corrupts it.
    expect(String(Number(cid))).not.toBe(cid);
    expect(String(Number(cid))).toBe('13019781180686529000');
    expect(BigInt(cid!) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('prefers an explicit ?cid= parameter', () => {
    expect(extractFromUrl('https://maps.google.com/?cid=14047229432529183851').cid).toBe(
      '14047229432529183851',
    );
  });

  it('prefers the place coordinates over the map viewport', () => {
    // @-coords are where the map was centred, which is not the business.
    const result = extractFromUrl(
      'https://www.google.com/maps/place/X/@40.0,-70.0,17z/data=!4m6!3m5!1s0x1:0x2!8m2!3d33.5!4d-86.8',
    );
    expect(result.lat).toBe(33.5);
    expect(result.lng).toBe(-86.8);
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', 'not a url', 'https://', '%%%%']) {
      expect(() => extractFromUrl(bad)).not.toThrow();
      expect(extractFromUrl(bad).cid).toBeNull();
    }
  });

  it('rejects a malformed fid', () => {
    expect(cidFromFid('garbage')).toBeNull();
    expect(cidFromFid('0xabc')).toBeNull();
    expect(cidFromFid('0xzz:0xzz')).toBeNull();
  });

  it('identifies place URLs', () => {
    expect(isPlaceUrl(REAL_URL)).toBe(true);
    expect(isPlaceUrl('https://www.google.com/maps/search/plumber')).toBe(false);
  });

  it('keys the same place identically despite differing tracking parameters', () => {
    // The feed re-renders while scrolling and returns the same place with new
    // parameters. String comparison would count it as new forever, so
    // stagnation would never trigger and the scroll would never terminate.
    expect(placeUrlKey(REAL_URL)).toBe(placeUrlKey(`${REAL_URL}&entry=ttu&g_ep=XYZ`));
  });
});

describe('website unwrapping', () => {
  it('unwraps the Google redirect the place page actually returns', () => {
    // Feeding the wrapper to the crawler sends every request to google.com — a
    // pipeline that looks healthy while producing zero emails.
    expect(unwrapGoogleRedirect('/url?q=http://realsite.com/&opi=89978449&usg=AOvVaw0')).toBe(
      'http://realsite.com/',
    );
  });

  it('leaves a direct URL untouched', () => {
    expect(unwrapGoogleRedirect('https://acme.com/contact')).toBe('https://acme.com/contact');
  });

  it('strips tracking parameters Google appends to business links', () => {
    // Captured live: the authority href carries utm_source=google etc.
    expect(
      normalizeWebsiteUrl(
        'https://mrdrippyplumbing.com/?utm_source=google&utm_medium=search_engine&utm_campaign=gmb',
      ),
    ).toBe('https://mrdrippyplumbing.com');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeWebsiteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsiteUrl('tel:+12055551234')).toBeNull();
  });

  it('resolves the registrable domain with the public suffix list', () => {
    expect(domainOf('https://www.acme.co.uk/x')?.domain).toBe('acme.co.uk');
    expect(domainOf('https://shop.example.com')?.domain).toBe('example.com');
  });

  it('flags social and Google-hosted sites as not crawlable', () => {
    // Crawling facebook.com for a business email finds Facebook's. And every
    // Google Sites business shares the registrable domain google.com, so one
    // crawl would wrongly satisfy all of them.
    expect(domainOf('https://facebook.com/biz')?.isSocial).toBe(true);
    expect(domainOf('https://sites.google.com/x/y')?.isSocial).toBe(true);
    expect(domainOf('https://mrdrippyplumbing.com')?.isSocial).toBe(false);
  });
});

describe('phone normalization', () => {
  it('normalizes the formats Google actually returns', () => {
    expect(toE164('(205) 202-1320')).toBe('+12052021320');
    expect(toE164('+1 205-236-0125')).toBe('+12052360125');
    expect(toE164('205.928.5093')).toBe('+12059285093');
    expect(toE164('1-877-902-5309')).toBe('+18779025309');
  });

  it('rejects the negative 64-bit ids the XHR payload is full of', () => {
    // Observed live: the XHR channel offered -8608314605215539785 as a phone.
    expect(toE164('-8608314605215539785')).toBeNull();
  });

  it('rejects numbers that violate NANP structure', () => {
    expect(toE164('(105) 202-1320')).toBeNull(); // area code cannot start with 1
    expect(toE164('(205) 102-1320')).toBeNull(); // exchange cannot start with 1
    expect(toE164('12345')).toBeNull();
  });

  it('returns null for a non-US number rather than mangling it into +1', () => {
    expect(toE164('+44 20 7946 0958')).toBeNull();
  });
});

describe('address parsing', () => {
  it('splits the format Google returns', () => {
    expect(parseUsAddress('137 W Oxmoor Rd Ste 405, Birmingham, AL 35209, United States')).toEqual({
      street: '137 W Oxmoor Rd Ste 405',
      city: 'Birmingham',
      stateCode: 'AL',
      postalCode: '35209',
      country: 'US',
    });
  });

  it('handles ZIP+4', () => {
    expect(parseUsAddress('1 Main St, Boston, MA 02108-1234').postalCode).toBe('02108');
  });

  it('keeps the raw string rather than guessing when the shape is unfamiliar', () => {
    // A half-parsed address is worse than an unparsed one.
    const parsed = parseUsAddress('Somewhere in the woods');
    expect(parsed.street).toBe('Somewhere in the woods');
    expect(parsed.city).toBeNull();
    expect(parsed.stateCode).toBeNull();
  });
});

describe('rating and review parsing', () => {
  it('parses the live aria-label format', () => {
    expect(parseRating('4.9 stars ')).toBe(4.9);
    expect(parseRating(4.8)).toBe(4.8);
  });

  it('rejects out-of-range ratings', () => {
    expect(parseRating('9.5 stars')).toBeNull();
  });

  it('parses review counts with separators', () => {
    expect(parseReviewCount('1,234 reviews')).toBe(1234);
    expect(parseReviewCount('(567)')).toBe(567);
  });
});

describe('dedup hashing', () => {
  it('uses the CID when there is one', () => {
    expect(dedupHash({ cid: '123', name: 'Acme' })).toBe('cid:123');
  });

  it('falls back to a content hash for the listings with no CID', () => {
    const hash = dedupHash({
      cid: null,
      name: 'Acme',
      phoneE164: '+12055551234',
      lat: 33.5,
      lng: -86.8,
    });
    expect(hash).toMatch(/^h:[0-9a-f]{24}$/);
  });

  it('collapses the same business seen twice', () => {
    const a = dedupHash({
      name: 'Acme Plumbing',
      phoneE164: '+12055551234',
      lat: 33.51867,
      lng: -86.80971,
    });
    const b = dedupHash({
      name: 'acme  plumbing',
      phoneE164: '+12055551234',
      lat: 33.51869,
      lng: -86.80972,
    });
    expect(a).toBe(b);
  });

  it('keeps neighbouring businesses distinct', () => {
    const a = dedupHash({ name: 'Acme', phoneE164: '+12055551234', lat: 33.51, lng: -86.8 });
    const b = dedupHash({ name: 'Beta', phoneE164: '+12055559999', lat: 33.51, lng: -86.8 });
    expect(a).not.toBe(b);
  });
});

describe('search URL building', () => {
  it('pins the locale on every URL', () => {
    // Three mechanisms depend on English: the star aria-label, the end-of-list
    // sentinel, and the consent button labels.
    const url = buildSearchUrl({
      city: 'Birmingham',
      stateCode: 'AL',
      category: 'Plumber',
      lat: 33.5,
      lng: -86.8,
    });
    expect(url).toContain('hl=en');
    expect(url).toContain('gl=us');
  });

  it('renders the default query template', () => {
    expect(
      buildQuery({ city: 'Birmingham', stateCode: 'AL', category: 'Plumber', lat: 0, lng: 0 }),
    ).toBe('Plumber in Birmingham, AL');
    expect(DEFAULT_QUERY_TEMPLATE).toContain('{category}');
  });

  it('encodes categories containing slashes', () => {
    const url = buildSearchUrl({
      city: 'Boston',
      stateCode: 'MA',
      category: 'Garage door repair/Installation',
      lat: 0,
      lng: 0,
    });
    expect(url).not.toContain('repair/Installation');
    expect(() => new URL(url)).not.toThrow();
  });

  it('supports coordinate mode', () => {
    const url = buildSearchUrl(
      { city: 'X', stateCode: 'AL', category: 'Y', lat: 33.5, lng: -86.8 },
      { mode: 'coordinates', zoom: 14 },
    );
    expect(url).toContain('@33.5,-86.8,14z');
  });
});

describe('XHR channel', () => {
  it('strips the anti-hijacking prefix', () => {
    expect(parseXhrBody(")]}'\n[[1,2,3]]")).toEqual([[1, 2, 3]]);
  });

  it('returns null on unparseable bodies rather than throwing', () => {
    expect(parseXhrBody('not json')).toBeNull();
    expect(parseXhrBody('')).toBeNull();
  });

  it('reads nested paths without throwing on a changed shape', () => {
    // A rotted index must return undefined, never abort the job.
    expect(at([[1, [2, 3]]], 0, 1, 0)).toBe(2);
    expect(at([], 5, 9, 2)).toBeUndefined();
    expect(at(null, 0)).toBeUndefined();
  });

  it('recognises place endpoints', () => {
    expect(isPlaceEndpoint('https://www.google.com/maps/preview/place?x=1')).toBe(true);
    expect(isPlaceEndpoint('https://www.google.com/images/logo.png')).toBe(false);
  });

  it('yields all-null rather than throwing when the payload shape is unknown', () => {
    const result = extractFromXhr({ unexpected: 'shape' });
    expect(result.name).toBeNull();
    expect(result.cid).toBeNull();
  });

  it('merges payloads without letting a later thin one erase earlier detail', () => {
    const collector = new XhrCollector();
    collector.add(
      JSON.stringify(['0x1:0xb4af8e008822f33a', 'x', 1, 2, 3, 4, 5, 'https://acme.com']),
    );
    collector.add(JSON.stringify([1, 2]));
    expect(collector.best().cid).toBe('13019781180686529338');
  });
});

function dom(overrides: Partial<DomExtraction> = {}): DomExtraction {
  return {
    name: null,
    categoryPrimary: null,
    address: null,
    phone: null,
    website: null,
    rating: null,
    reviews: null,
    plusCode: null,
    hours: null,
    thumbnail: null,
    permanentlyClosed: false,
    ...overrides,
  };
}

const EMPTY_XHR = {
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

describe('channel merge', () => {
  it('records which channel supplied each field', () => {
    const result = mergeExtractions({
      url: extractFromUrl(REAL_URL),
      xhr: { ...EMPTY_XHR, name: 'From XHR' },
      dom: dom({ phone: '+12052360125' }),
      gmapsUrl: REAL_URL,
    });

    expect(result.provenance.cid).toBe('url');
    expect(result.provenance.name).toBe('xhr');
    expect(result.provenance.phoneRaw).toBe('dom');
  });

  it('skips a higher-priority channel that supplies an unusable phone', () => {
    // The live failure: XHR offered a negative 64-bit id and blocked the DOM's
    // perfectly good number, leaving phone fill at 0%.
    const result = mergeExtractions({
      url: extractFromUrl(REAL_URL),
      xhr: { ...EMPTY_XHR, phone: '-8608314605215539785' },
      dom: dom({ phone: '+12052360125' }),
      gmapsUrl: REAL_URL,
    });

    expect(result.business.phoneE164).toBe('+12052360125');
    expect(result.provenance.phoneRaw).toBe('dom');
  });

  it('unwraps and normalizes the website during the merge', () => {
    const result = mergeExtractions({
      url: extractFromUrl(REAL_URL),
      xhr: EMPTY_XHR,
      dom: dom({ website: '/url?q=https://acme.com/&usg=x' }),
      gmapsUrl: REAL_URL,
    });

    expect(result.business.websiteUrl).toBe('https://acme.com');
    expect(result.business.domain).toBe('acme.com');
  });

  it('lets the URL channel supply identity even when everything else is empty', () => {
    // The URL channel cannot rot, so it is the floor beneath the other two.
    const result = mergeExtractions({
      url: extractFromUrl(REAL_URL),
      xhr: EMPTY_XHR,
      dom: dom(),
      gmapsUrl: REAL_URL,
    });

    expect(result.business.cid).toBe('13019781180686529338');
    expect(result.business.lat).toBeCloseTo(33.4463309, 5);
    expect(result.dedupHash).toBe('cid:13019781180686529338');
  });
});

describe('selector-rot health guard', () => {
  function record(tracker: FillRateTracker, count: number, withName: boolean): void {
    for (let i = 0; i < count; i += 1) {
      tracker.record(
        mergeExtractions({
          url: extractFromUrl(withName ? REAL_URL : 'https://example.com'),
          xhr: withName ? { ...EMPTY_XHR, name: `Business ${i}` } : EMPTY_XHR,
          dom: dom(),
          gmapsUrl: REAL_URL,
        }),
      );
    }
  }

  it('stays quiet while extraction is healthy', () => {
    const tracker = new FillRateTracker();
    record(tracker, 30, true);
    expect(checkHealth(tracker).healthy).toBe(true);
  });

  it('does not fire before it has a meaningful sample', () => {
    // A handful of odd listings must not abort a healthy run in its first
    // seconds.
    const tracker = new FillRateTracker();
    record(tracker, 3, false);
    expect(checkHealth(tracker).healthy).toBe(true);
  });

  it('fires when names stop being extracted', () => {
    // The legacy system had no such guard and wrote thousands of null rows that
    // looked like completed work.
    const tracker = new FillRateTracker();
    record(tracker, 30, false);

    const verdict = checkHealth(tracker);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(/name fill rate/);
  });

  it('reports per-field rates for diagnosis', () => {
    const tracker = new FillRateTracker();
    record(tracker, 20, true);
    const rates = tracker.rates();
    expect(rates.name).toBe(1);
    expect(rates.cid).toBe(1);
    expect(rates.websiteUrl).toBe(0);
  });

  it('attributes fields to channels, so rot can be located', () => {
    const tracker = new FillRateTracker();
    record(tracker, 5, true);
    expect(tracker.channelBreakdown()['name:xhr']).toBe(5);
    expect(tracker.channelBreakdown()['cid:url']).toBe(5);
  });
});
