/**
 * A French campaign: phones, addresses, search phrases and seed lists.
 *
 * Every function here keeps its US behaviour by default — the US campaign's
 * own tests cover that — so these only add the French side.
 */
import { describe, expect, it } from 'vitest';
import { extractFromUrl } from '../src/automations/google-maps/extract/from-url.js';
import { extractFromXhr } from '../src/automations/google-maps/extract/from-xhr.js';
import { mergeExtractions } from '../src/automations/google-maps/extract/merge.js';
import type { DomExtraction } from '../src/automations/google-maps/extract/from-dom.js';
import {
  cityLabel,
  departementOf,
  formatNational,
  isMobileNumber,
  parseAddress,
  toE164,
} from '../src/automations/google-maps/normalize.js';
import { buildQuery, buildSearchUrl } from '../src/automations/google-maps/search.js';
import { detectBlock } from '../src/core/browser/block-detector.js';
import { normalizeStateCode } from '../src/importers/normalize.js';
import { parseCityRows } from '../src/importers/seeds.js';
import { readCsv } from '../src/importers/xlsx.js';
import { parseCityForm } from '../src/seeds/manage.js';
import { FRENCH_LABELS, localizePage } from '../src/ui/server.js';
import { PAGE } from '../src/ui/page.js';
import { loadConfig } from '../src/config/loader.js';
import { campaignDir } from '../src/core/util/paths.js';
import path from 'node:path';

describe('French phone numbers', () => {
  it('normalizes the forms Google and websites show', () => {
    expect(toE164('01 42 33 44 55', 'FR')).toBe('+33142334455');
    expect(toE164('01.42.33.44.55', 'FR')).toBe('+33142334455');
    expect(toE164('0142334455', 'FR')).toBe('+33142334455');
    expect(toE164('+33 1 42 33 44 55', 'FR')).toBe('+33142334455');
    expect(toE164('+33 (0)6 12 34 56 78', 'FR')).toBe('+33612345678');
    expect(toE164('0033 7 12 34 56 78', 'FR')).toBe('+33712345678');
    expect(toE164('tel:+33612345678', 'FR')).toBe('+33612345678');
  });

  it('rejects what is not a French number', () => {
    expect(toE164('+44 20 7946 0958', 'FR')).toBeNull();
    expect(toE164('-8608314605215539785', 'FR')).toBeNull();
    expect(toE164('00 42 33 44 55', 'FR')).toBeNull(); // no area digit 0
    expect(toE164('01 42 33 44', 'FR')).toBeNull();
    expect(toE164('(205) 202-1320', 'FR')).toBeNull();
  });

  it('is never applied to a US campaign', () => {
    expect(toE164('01 42 33 44 55')).toBeNull();
  });

  it('spots mobiles and writes numbers the French way', () => {
    expect(isMobileNumber('+33612345678')).toBe(true);
    expect(isMobileNumber('+33712345678')).toBe(true);
    expect(isMobileNumber('+33142334455')).toBe(false);
    expect(formatNational('+33612345678')).toBe('06 12 34 56 78');
    expect(formatNational('+12052021320')).toBe('+12052021320');
    expect(formatNational(null)).toBeNull();
  });
});

describe('French addresses', () => {
  it('splits the format Google returns, labelling the arrondissement', () => {
    expect(parseAddress('12 Rue de Charonne, 75011 Paris, France', 'FR')).toEqual({
      street: '12 Rue de Charonne',
      city: 'Paris 11e',
      stateCode: '75',
      postalCode: '75011',
      country: 'FR',
    });
    expect(parseAddress('3 Rue X, 75001 Paris', 'FR').city).toBe('Paris 1er');
    expect(parseAddress('Av. Foch, 75116 Paris', 'FR').city).toBe('Paris 16e');
  });

  it('handles the suburbs, Corsica and overseas', () => {
    const montreuil = parseAddress('5 Rue de Paris, 93100 Montreuil', 'FR');
    expect(montreuil.city).toBe('Montreuil');
    expect(montreuil.stateCode).toBe('93');
    expect(departementOf('20000')).toBe('2A');
    expect(departementOf('20200')).toBe('2B');
    expect(departementOf('97400')).toBe('974');
    expect(parseAddress('1 Bd Y, 69002 Lyon', 'FR').city).toBe('Lyon 2e');
    expect(parseAddress('1 Bd Y, 13008 Marseille', 'FR').city).toBe('Marseille 8e');
    expect(parseAddress('ZI Nord, 92000 Nanterre Cedex 3', 'FR').city).toBe('Nanterre');
  });

  it('keeps the raw string rather than guessing at an unfamiliar shape', () => {
    const parsed = parseAddress('Quelque part', 'FR');
    expect(parsed.street).toBe('Quelque part');
    expect(parsed.postalCode).toBeNull();
  });

  it('leaves a city with no arrondissements as named', () => {
    expect(cityLabel('75020', 'Paris')).toBe('Paris 20e');
    expect(cityLabel('75021', 'Paris')).toBe('Paris');
    expect(cityLabel(null, 'Bordeaux')).toBe('Bordeaux');
  });
});

function dom(overrides: Partial<DomExtraction> = {}): DomExtraction {
  return {
    name: 'Salon Test',
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

const PARIS_URL =
  'https://www.google.com/maps/place/Salon/@48.86,2.38,17z/data=!4m6!3m5!1s0x47e66dfb3a9b1c3d:0x1a2b3c4d5e6f7a8b!8m2!3d48.86!4d2.38?hl=en';

describe('merging a French listing', () => {
  it('keeps the phone and parses the address the French way', () => {
    const result = mergeExtractions({
      url: extractFromUrl(PARIS_URL),
      xhr: extractFromXhr(null),
      dom: dom({ phone: '01 42 33 44 55', address: '12 Rue de Charonne, 75011 Paris' }),
      gmapsUrl: PARIS_URL,
      country: 'FR',
    });
    expect(result.business.phoneE164).toBe('+33142334455');
    expect(result.business.city).toBe('Paris 11e');
    expect(result.business.stateCode).toBe('75');
  });

  it('keeps the panel phone even when no rule accepts it', () => {
    // Before, a number the US rule refused was dropped, raw text and all.
    const result = mergeExtractions({
      url: extractFromUrl(PARIS_URL),
      xhr: extractFromXhr(null),
      dom: dom({ phone: '+32 2 123 45 67' }),
      gmapsUrl: PARIS_URL,
      country: 'FR',
    });
    expect(result.business.phoneRaw).toBe('+32 2 123 45 67');
    expect(result.business.phoneE164).toBeNull();
  });

  it('finds a French number in a place payload', () => {
    const payload = [
      ['0x47e66dfb3a9b1c3d:0x1a2b3c4d5e6f7a8b', '-8608314605215539785', '01 42 33 44 55'],
    ];
    expect(extractFromXhr(payload, undefined, 'FR').phone).toBe('01 42 33 44 55');
    expect(extractFromXhr(payload, undefined, 'US').phone).toBeNull();
  });
});

describe('searching in France', () => {
  const target = {
    city: 'Paris 11e',
    stateCode: '75',
    zip: '75011',
    category: 'tresses',
    lat: 48.86,
    lng: 2.38,
  };

  it('renders the template without a state', () => {
    expect(buildQuery(target, '{category} {city}')).toBe('tresses Paris 11e');
    expect(buildQuery(target, '{category} {zip} {city}')).toBe('tresses 75011 Paris 11e');
    // A job planned before zips were in its params renders cleanly too.
    const { zip: _zip, ...withoutZip } = target;
    expect(buildQuery(withoutZip, '{category} {zip} {city}')).toBe('tresses Paris 11e');
  });

  it('keeps the interface in English but biases results to France', () => {
    const url = new URL(buildSearchUrl(target, { queryTemplate: '{category} {city}', gl: 'fr' }));
    expect(url.searchParams.get('hl')).toBe('en');
    expect(url.searchParams.get('gl')).toBe('fr');
    expect(decodeURIComponent(url.pathname)).toContain('tresses Paris 11e');
  });

  it('recognises the French block page', () => {
    expect(
      detectBlock({
        url: 'https://www.google.com/maps',
        bodyText: 'Nos systèmes ont détecté un trafic exceptionnel sur votre réseau.',
      }).blocked,
    ).toBe(true);
  });
});

describe('French seed lists', () => {
  it('accepts départements as the region', () => {
    expect(normalizeStateCode('75')).toBe('75');
    expect(normalizeStateCode('2a')).toBe('2A');
    expect(normalizeStateCode('974')).toBe('974');
    expect(normalizeStateCode('6')).toBe('06');
    expect(normalizeStateCode('GA')).toBe('GA');
    expect(normalizeStateCode('00')).toBeNull();
    expect(normalizeStateCode('Georgia')).toBeNull();
  });

  it('loads every Paris arrondissement from the campaign lists', () => {
    const dir = path.join(campaignDir('gobadiz'), 'seeds');
    const parsed = parseCityRows(readCsv(path.join(dir, 'cities.csv')), 'cities.csv');
    expect(parsed.rejected).toEqual([]);
    expect(parsed.cities).toHaveLength(20);
    expect(parsed.cities[10]).toMatchObject({
      zip: '75011',
      city: 'Paris 11e',
      stateCode: '75',
      state: 'Paris',
      countyFips: '75111',
    });
  });

  it('takes a département in the dashboard form', () => {
    const city = parseCityForm({
      zip: '93100',
      city: 'Montreuil',
      stateCode: '93',
      coordinates: '48.8611, 2.4437',
    });
    expect(city.state).toBe('Seine-Saint-Denis');
  });
});

describe('the Gobadiz campaign', () => {
  it('is set up for France', () => {
    const config = loadConfig({ cwd: campaignDir('gobadiz'), env: {} });
    expect(config.market).toMatchObject({ country: 'FR', gl: 'fr' });
    expect(config.browser.timezoneId).toBe('Europe/Paris');
  });

  it('keeps the main campaign on the US defaults', () => {
    const config = loadConfig({ cwd: campaignDir('gobadiz').replace(/campaigns.*$/, ''), env: {} });
    expect(config.market).toMatchObject({
      country: 'US',
      gl: 'us',
      queryTemplate: '{category} in {city}, {stateCode}',
    });
  });
});

describe('dashboard wording', () => {
  it('says département and postcode on a French campaign', () => {
    const fr = localizePage(PAGE, 'FR');
    expect(fr).toContain('<th>Dépt</th><th>Postcode</th>');
    expect(fr).not.toContain('All states');
    expect(localizePage(PAGE, 'US')).toBe(PAGE);
  });

  it('matches every US string it replaces, so none goes stale', () => {
    for (const [us] of FRENCH_LABELS) expect(PAGE, us).toContain(us);
  });
});
