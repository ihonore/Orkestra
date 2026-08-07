/**
 * Seed-data normalization.
 *
 * Spreadsheets lose leading zeros. Every value that is an identifier made of
 * digits — zip, FIPS — has to be repaired on the way in, because once a zip is
 * stored as `901` instead of `00901` it will silently fail to join against any
 * other dataset, and nothing about the row looks wrong.
 *
 * Measured on the source workbook: 8 of 185 zips and 27 of 185 county FIPS codes
 * had lost a leading zero.
 */

/** US zips are 5 digits; ZIP+4 is truncated to the 5-digit prefix. */
export function normalizeZip(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const digits = String(input)
    .trim()
    .replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  // ZIP+4 ("30301-1234" -> "303011234"): keep the leading 5.
  if (digits.length > 5) return digits.slice(0, 5);
  return digits.padStart(5, '0');
}

/**
 * Combined state+county FIPS, zero-padded to 5 (2-digit state + 3-digit county).
 *
 * The source stores these as a single number, so Jefferson County, Alabama
 * (state 01, county 073) arrives as `1073` and must become `01073`.
 */
export function normalizeCountyFips(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const digits = String(input)
    .trim()
    .replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  if (digits.length > 5) return null; // not a county FIPS
  return digits.padStart(5, '0');
}

/** The 2-letter state FIPS prefix of a combined county FIPS. */
export function stateFipsOf(countyFips: string | null): string | null {
  return countyFips === null ? null : countyFips.slice(0, 2);
}

export function normalizeStateCode(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * A URL- and filename-safe identifier for a category.
 *
 * Category names contain slashes ('Garage door repair/Installation'), ampersands
 * and mixed case. The slug is the stable key the database uniques on, so it must
 * be deterministic and must not collapse two distinct categories into one.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    // Strip combining marks so accented names transliterate rather than vanish.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'category' : slug;
}

/**
 * Trim to a string, mapping blanks and spreadsheet placeholder text to null.
 *
 * Only primitives are stringified. A Date cell in a text column would otherwise
 * become "Mon Jan 01 2024 00:00:00 GMT+0000", and an object "[object Object]" —
 * both of which would be stored as if they were real data.
 */
export function cleanText(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean') {
    return null;
  }
  const text = String(input).trim();
  if (text === '' || text.toLowerCase() === 'null' || text.toLowerCase() === 'n/a') return null;
  return text;
}

/** Parse a spreadsheet cell to a finite number, or null. */
export function cleanNumber(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const n = Number(input.trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function isValidLatitude(n: number | null): n is number {
  return n !== null && n >= -90 && n <= 90;
}

export function isValidLongitude(n: number | null): n is number {
  return n !== null && n >= -180 && n <= 180;
}
