import { describe, expect, it } from 'vitest';
import {
  cleanNumber,
  cleanText,
  normalizeCountyFips,
  normalizeZip,
  slugify,
} from '../src/importers/normalize.js';
import { parseCategoryRows, parseCityRows } from '../src/importers/seeds.js';
import { column, headerIndex } from '../src/importers/xlsx.js';
import type { SheetRows } from '../src/importers/xlsx.js';

describe('zip normalization', () => {
  it('restores leading zeros lost by the spreadsheet', () => {
    // Every one of these is a real city in the source workbook whose zip had
    // been stored as a number.
    expect(normalizeZip('901')).toBe('00901'); // San Juan, PR
    expect(normalizeZip('6510')).toBe('06510'); // New Haven, CT
    expect(normalizeZip('2108')).toBe('02108'); // Boston, MA
  });

  it('accepts a numeric cell as readily as a string', () => {
    expect(normalizeZip(6510)).toBe('06510');
  });

  it('leaves a well-formed zip alone', () => {
    expect(normalizeZip('35203')).toBe('35203');
  });

  it('truncates ZIP+4 to the 5-digit prefix', () => {
    expect(normalizeZip('30301-1234')).toBe('30301');
  });

  it('returns null for a blank or unparseable value', () => {
    expect(normalizeZip('')).toBeNull();
    expect(normalizeZip(null)).toBeNull();
    expect(normalizeZip('n/a')).toBeNull();
  });
});

describe('county FIPS normalization', () => {
  it('pads the combined state+county code to five digits', () => {
    expect(normalizeCountyFips('1073')).toBe('01073'); // Jefferson County, AL
    expect(normalizeCountyFips('9009')).toBe('09009'); // New Haven County, CT
  });

  it('leaves a five-digit code alone', () => {
    expect(normalizeCountyFips('25025')).toBe('25025');
  });

  it('rejects anything longer than a county FIPS', () => {
    expect(normalizeCountyFips('123456')).toBeNull();
  });
});

describe('slugify', () => {
  it('handles the slash-bearing category names in the source sheet', () => {
    expect(slugify('Garage door repair/Installation')).toBe('garage-door-repair-installation');
    expect(slugify('Business/Commercial Lending')).toBe('business-commercial-lending');
  });

  it('spells out ampersands so "A & B" and "A B" stay distinct', () => {
    expect(slugify('Heating & Cooling')).toBe('heating-and-cooling');
    expect(slugify('Heating Cooling')).toBe('heating-cooling');
  });

  it('transliterates accents rather than dropping the word', () => {
    expect(slugify('Café Services')).toBe('cafe-services');
  });

  it('never returns an empty slug', () => {
    expect(slugify('///')).toBe('category');
  });
});

describe('cell cleaning', () => {
  it('maps spreadsheet placeholder text to null', () => {
    expect(cleanText('null')).toBeNull();
    expect(cleanText('N/A')).toBeNull();
    expect(cleanText('   ')).toBeNull();
    expect(cleanText('Birmingham')).toBe('Birmingham');
  });

  it('parses numbers, including thousands separators', () => {
    expect(cleanNumber('1,234')).toBe(1234);
    expect(cleanNumber(33.51867)).toBe(33.51867);
    expect(cleanNumber('not a number')).toBeNull();
  });
});

describe('header matching', () => {
  it('matches case- and whitespace-insensitively', () => {
    const index = headerIndex(['ZipCode', '  County  Code ', 'STATE Code']);
    expect(column(index, 'zipcode')).toBe(0);
    expect(column(index, 'county code')).toBe(1);
    expect(column(index, 'state code')).toBe(2);
  });

  it('accepts any of several spellings', () => {
    const index = headerIndex(['Longitude']);
    expect(column(index, 'lng', 'lon', 'longitude')).toBe(0);
    expect(column(index, 'nope')).toBeNull();
  });
});

const CITY_HEADER = [
  'ZipCode',
  'County',
  'City',
  'State',
  'County Code',
  'State Code',
  'Latitude',
  'Longitude',
  'STATUS',
];

function cityRows(...rows: SheetRows): SheetRows {
  return [CITY_HEADER, ...rows];
}

describe('parseCityRows', () => {
  it('repairs zips and FIPS codes and reports each repair', () => {
    const parsed = parseCityRows(
      cityRows([
        '901',
        'San Juan',
        'San Juan',
        'Puerto Rico',
        '72127',
        'PR',
        18.46,
        -66.11,
        'TODO',
      ]),
      'test',
    );

    expect(parsed.cities).toHaveLength(1);
    expect(parsed.cities[0]?.zip).toBe('00901');
    expect(parsed.repairs).toEqual([{ row: 2, field: 'zip', from: '901', to: '00901' }]);
  });

  it('keeps the legacy STATUS as provenance without acting on it', () => {
    const parsed = parseCityRows(
      cityRows(['35203', 'Jefferson', 'Birmingham', 'Alabama', '1073', 'AL', 33.51, -86.8, 'DONE']),
      'test',
    );
    expect(parsed.cities[0]?.legacyStatus).toBe('DONE');
  });

  it('rejects a row with invalid coordinates rather than storing it', () => {
    const parsed = parseCityRows(
      cityRows(['35203', 'Jefferson', 'Birmingham', 'Alabama', '1073', 'AL', 999, -86.8, '']),
      'test',
    );
    expect(parsed.cities).toHaveLength(0);
    expect(parsed.rejected[0]?.reason).toBe('invalid coordinates');
  });

  it('rejects a duplicate zip instead of silently overwriting', () => {
    const parsed = parseCityRows(
      cityRows(
        ['35203', 'Jefferson', 'Birmingham', 'Alabama', '1073', 'AL', 33.51, -86.8, ''],
        ['35203', 'Jefferson', 'Birmingham Two', 'Alabama', '1073', 'AL', 33.52, -86.81, ''],
      ),
      'test',
    );
    expect(parsed.cities).toHaveLength(1);
    expect(parsed.rejected[0]?.reason).toBe('duplicate zip');
  });

  it('skips trailing blank rows silently — they are normal in a hand-kept sheet', () => {
    const parsed = parseCityRows(
      cityRows(
        ['35203', 'Jefferson', 'Birmingham', 'Alabama', '1073', 'AL', 33.51, -86.8, ''],
        [null, null, null, null, null, null, null, null, null],
      ),
      'test',
    );
    expect(parsed.cities).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(0);
  });

  it('fails loudly when a required column is absent', () => {
    expect(() =>
      parseCityRows(
        [
          ['City', 'State'],
          ['Birmingham', 'AL'],
        ],
        'test',
      ),
    ).toThrowError(/missing required column/i);
  });
});

describe('parseCategoryRows', () => {
  it('reads the legacy sheet whose header is prose, not a column name', () => {
    const parsed = parseCategoryRows([
      ['Services From NewToMedia.com', null, 'STATUS'],
      ['Business Broker', null, 'DONE'],
      ['Garage door repair/Installation', null, 'TODO'],
    ]);

    expect(parsed.categories).toHaveLength(2);
    expect(parsed.categories[0]).toMatchObject({
      name: 'Business Broker',
      slug: 'business-broker',
    });
    expect(parsed.categories[1]?.slug).toBe('garage-door-repair-installation');
  });

  it('refuses two names that would collapse to one slug', () => {
    // Silently overwriting would drop a whole category from every future run.
    const parsed = parseCategoryRows([['Services'], ['Roof Repair'], ['roof repair']]);

    expect(parsed.categories).toHaveLength(1);
    expect(parsed.rejected[0]?.reason).toMatch(/collides/);
  });

  it('splits an aliases column on pipes and semicolons', () => {
    const parsed = parseCategoryRows([
      ['Name', 'Aliases'],
      ['Plumber', 'Plumbing|Plumbing Contractor; Drain Service'],
    ]);
    expect(parsed.categories[0]?.aliases).toEqual([
      'Plumbing',
      'Plumbing Contractor',
      'Drain Service',
    ]);
  });
});
