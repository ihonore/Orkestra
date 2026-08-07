/**
 * Cities and categories importers.
 *
 * Both report every repair and every rejection rather than fixing things
 * silently. A seed import that quietly drops 12 rows is how a run ends up
 * missing a state and nobody notices for a week.
 */
import type { CategoryInput, CityInput } from '../db/repositories/seeds.js';
import { ImportError } from '../core/errors/taxonomy.js';
import {
  cleanNumber,
  cleanText,
  isValidLatitude,
  isValidLongitude,
  normalizeCountyFips,
  normalizeStateCode,
  normalizeZip,
  slugify,
} from './normalize.js';
import { column, headerIndex, readSpreadsheet, type SheetRows } from './xlsx.js';

/** A row that could not be imported, with the reason. */
export interface RejectedRow {
  readonly row: number;
  readonly reason: string;
  readonly value?: string;
}

/** A value that was corrected on the way in. */
export interface Repair {
  readonly row: number;
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface ParsedCities {
  readonly cities: CityInput[];
  readonly rejected: RejectedRow[];
  readonly repairs: Repair[];
  readonly totalRows: number;
}

export interface ParsedCategories {
  readonly categories: CategoryInput[];
  readonly rejected: RejectedRow[];
  readonly repairs: Repair[];
  readonly totalRows: number;
}

export interface ImportOptions {
  readonly sheet?: string | number;
  readonly source?: string;
}

/**
 * Parse a cities sheet.
 *
 * Accepts the legacy workbook's headers (`ZipCode`, `County Code`, `State
 * Code`) plus the obvious alternates, so a hand-made CSV also works.
 */
export async function parseCities(
  file: string,
  options: ImportOptions = {},
): Promise<ParsedCities> {
  const rows = await readSpreadsheet(file, {
    ...(options.sheet !== undefined && { sheet: options.sheet }),
  });
  return parseCityRows(rows, options.source ?? file);
}

export function parseCityRows(rows: SheetRows, source: string): ParsedCities {
  if (rows.length < 2) {
    throw new ImportError('Cities sheet has no data rows.', {
      code: 'IMPORT_EMPTY',
      hint: 'Expected a header row followed by at least one city.',
    });
  }

  const header = headerIndex(rows[0]!);
  const cZip = column(header, 'zipcode', 'zip', 'zip code', 'postal code');
  const cCity = column(header, 'city', 'city name');
  const cState = column(header, 'state', 'state name');
  const cStateCode = column(header, 'state code', 'statecode', 'state abbr', 'st');
  const cCounty = column(header, 'county', 'county name');
  const cCountyFips = column(header, 'county code', 'countycode', 'county fips', 'fips');
  const cLat = column(header, 'latitude', 'lat');
  const cLng = column(header, 'longitude', 'lng', 'lon', 'long');
  const cPopulation = column(header, 'population', 'pop');
  const cStatus = column(header, 'status');

  const missing: string[] = [];
  if (cZip === null) missing.push('ZipCode');
  if (cCity === null) missing.push('City');
  if (cLat === null) missing.push('Latitude');
  if (cLng === null) missing.push('Longitude');
  if (missing.length > 0) {
    throw new ImportError(`Cities sheet is missing required column(s): ${missing.join(', ')}`, {
      code: 'IMPORT_MISSING_COLUMN',
      hint: `Found headers: ${[...header.keys()].join(', ')}`,
    });
  }

  const cities: CityInput[] = [];
  const rejected: RejectedRow[] = [];
  const repairs: Repair[] = [];
  const seenZips = new Set<string>();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rowNumber = i + 1; // 1-based, counting the header — matches the UI
    const at = (col: number | null): unknown => (col === null ? null : row[col]);

    const rawZip = cleanText(at(cZip));
    const city = cleanText(at(cCity));
    // Blank trailing rows are normal in a hand-maintained sheet; skip silently.
    if (rawZip === null && city === null) continue;

    if (rawZip === null) {
      rejected.push({ row: rowNumber, reason: 'missing zip', value: city ?? '' });
      continue;
    }
    if (city === null) {
      rejected.push({ row: rowNumber, reason: 'missing city', value: rawZip });
      continue;
    }

    const zip = normalizeZip(rawZip);
    if (zip === null) {
      rejected.push({ row: rowNumber, reason: 'unparseable zip', value: rawZip });
      continue;
    }
    if (zip !== rawZip) {
      repairs.push({ row: rowNumber, field: 'zip', from: rawZip, to: zip });
    }
    if (seenZips.has(zip)) {
      rejected.push({ row: rowNumber, reason: 'duplicate zip', value: zip });
      continue;
    }
    seenZips.add(zip);

    const lat = cleanNumber(at(cLat));
    const lng = cleanNumber(at(cLng));
    if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
      rejected.push({ row: rowNumber, reason: 'invalid coordinates', value: `${lat}, ${lng}` });
      continue;
    }

    const rawFips = cleanText(at(cCountyFips));
    const countyFips = normalizeCountyFips(rawFips);
    if (rawFips !== null && countyFips !== null && countyFips !== rawFips) {
      repairs.push({ row: rowNumber, field: 'countyFips', from: rawFips, to: countyFips });
    }

    const stateCode = normalizeStateCode(cleanText(at(cStateCode)));
    const state = cleanText(at(cState));
    if (stateCode === null) {
      rejected.push({ row: rowNumber, reason: 'missing or invalid state code', value: city });
      continue;
    }

    cities.push({
      zip,
      city,
      state: state ?? stateCode,
      stateCode,
      county: cleanText(at(cCounty)),
      countyFips,
      lat,
      lng,
      population: cleanNumber(at(cPopulation)),
      legacyStatus: cleanText(at(cStatus)),
      source,
    });
  }

  return { cities, rejected, repairs, totalRows: rows.length - 1 };
}

/** Parse a categories/services sheet. The first column is the category name. */
export async function parseCategories(
  file: string,
  options: ImportOptions = {},
): Promise<ParsedCategories> {
  const rows = await readSpreadsheet(file, {
    ...(options.sheet !== undefined && { sheet: options.sheet }),
  });
  return parseCategoryRows(rows);
}

export function parseCategoryRows(rows: SheetRows): ParsedCategories {
  if (rows.length < 2) {
    throw new ImportError('Categories sheet has no data rows.', {
      code: 'IMPORT_EMPTY',
      hint: 'Expected a header row followed by at least one category.',
    });
  }

  const header = headerIndex(rows[0]!);
  // The legacy header is the prose 'Services From NewToMedia.com', so fall back
  // to column 0 rather than demanding a recognisable name.
  const cName = column(header, 'name', 'category', 'service', 'services') ?? 0;
  const cStatus = column(header, 'status');
  const cWeight = column(header, 'weight', 'priority');
  const cAliases = column(header, 'aliases', 'alternates');

  const categories: CategoryInput[] = [];
  const rejected: RejectedRow[] = [];
  const repairs: Repair[] = [];
  const seenSlugs = new Map<string, string>();

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rowNumber = i + 1;
    const name = cleanText(row[cName]);
    if (name === null) continue; // trailing blank row

    const slug = slugify(name);
    const clash = seenSlugs.get(slug);
    if (clash !== undefined) {
      // Two distinct names collapsing to one slug would silently drop a whole
      // category from every future run, so refuse rather than overwrite.
      rejected.push({
        row: rowNumber,
        reason: `slug '${slug}' collides with '${clash}'`,
        value: name,
      });
      continue;
    }
    seenSlugs.set(slug, name);

    const rawAliases = cleanText(cAliases === null ? null : row[cAliases]);
    const aliases =
      rawAliases === null
        ? null
        : rawAliases
            .split(/[|;]/)
            .map((a) => a.trim())
            .filter((a) => a !== '');

    categories.push({
      name,
      slug,
      aliases,
      weight: cleanNumber(cWeight === null ? null : row[cWeight]) ?? 1.0,
      legacyStatus: cleanText(cStatus === null ? null : row[cStatus]),
    });
  }

  return { categories, rejected, repairs, totalRows: rows.length - 1 };
}
