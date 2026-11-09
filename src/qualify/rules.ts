/**
 * The rules that decide which businesses a campaign wants.
 *
 * Pure: given a business and the rules, say what it is (its specialty, its
 * category in the campaign's words) and why it is not wanted, if it is not.
 * The database pass in `pass.ts` applies this to every stored business.
 *
 * Names are compared folded — accents, case and punctuation removed — and by
 * whole words, so "Jean-Louis David" matches the chain "Jean Louis David",
 * and the keyword "hotel" does not match "Hotelia Nails".
 */
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { column, headerIndex, readCsv } from '../importers/xlsx.js';

/** Lowercase, accents and punctuation removed, single spaces. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether `phrase` occurs in `text` as whole words. Both already folded. */
function hasPhrase(text: string, phrase: string): boolean {
  return phrase !== '' && ` ${text} `.includes(` ${phrase} `);
}

export interface CategoryRule {
  /** The category in the campaign's words: "Onglerie" for "Nail salon". */
  readonly label: string | null;
  /** Blank means "take it from the search that found the business". */
  readonly specialty: string | null;
  /** A reason to leave the business out, or null. */
  readonly exclude: string | null;
}

export interface NameRule {
  readonly reason: string;
  /** Folded phrases, any of which in the name triggers the rule. */
  readonly names: readonly string[];
  /** Folded Google categories the rule is limited to; null for any. */
  readonly categories: ReadonlySet<string> | null;
}

export interface QualifyRules {
  /** By folded Google category. */
  readonly categories: ReadonlyMap<string, CategoryRule>;
  /** Folded chain name, with the name as written for the reason. */
  readonly chains: readonly { readonly folded: string; readonly name: string }[];
  readonly nameRules: readonly NameRule[];
  readonly chainSiteThreshold: number;
  readonly activeAreasOnly: boolean;
}

export const NO_RULES: QualifyRules = {
  categories: new Map(),
  chains: [],
  nameRules: [],
  chainSiteThreshold: 3,
  activeAreasOnly: false,
};

export interface QualifyInput {
  readonly name: string;
  /** Google's primary category, in English. */
  readonly category: string | null;
  /** The département (or state) from the business's own address. */
  readonly region: string | null;
  readonly permanentlyClosed: boolean;
  /** Specialty of the search term that first found it. */
  readonly searchSpecialty: string | null;
  /** The business's website domain, when it has a crawlable one. */
  readonly siteDomain: string | null;
  /** How many stored listings share that website. */
  readonly siteListings: number;
}

export interface Qualification {
  readonly specialty: string | null;
  readonly categoryLabel: string | null;
  /** Null when the business is wanted. */
  readonly exclusionReason: string | null;
}

/**
 * Qualify one business.
 *
 * The first matching reason wins, in an order chosen so the reason the team
 * reads is the most useful one: closed before chain, chain before category.
 */
export function qualify(
  input: QualifyInput,
  rules: QualifyRules,
  activeRegions: ReadonlySet<string>,
): Qualification {
  const name = fold(input.name);
  const category = input.category === null ? null : fold(input.category);
  const mapped = category === null ? undefined : rules.categories.get(category);

  const specialty = mapped?.specialty ?? input.searchSpecialty;
  const categoryLabel = mapped?.label ?? input.category;
  const out = (exclusionReason: string | null): Qualification => ({
    specialty,
    categoryLabel,
    exclusionReason,
  });

  if (input.permanentlyClosed) return out('Fermé définitivement');

  const chain = rules.chains.find((c) => hasPhrase(name, c.folded));
  if (chain !== undefined) return out(`Chaîne (${chain.name})`);

  if (mapped?.exclude !== null && mapped?.exclude !== undefined) return out(mapped.exclude);

  for (const rule of rules.nameRules) {
    if (rule.categories !== null && (category === null || !rule.categories.has(category))) continue;
    if (rule.names.length === 0 || rule.names.some((phrase) => hasPhrase(name, phrase))) {
      return out(rule.reason);
    }
  }

  if (input.siteDomain !== null && input.siteListings >= rules.chainSiteThreshold) {
    return out(`Chaîne (${input.siteListings} fiches, même site ${input.siteDomain})`);
  }

  if (rules.activeAreasOnly && input.region !== null && !activeRegions.has(input.region)) {
    return out(`Hors zone (${input.region})`);
  }

  return out(null);
}

// ── Loading ────────────────────────────────────────────────────────────────

export class RulesError extends Error {}

/**
 * Read the category map: Google category, Libellé, Spécialité, Exclure.
 * Header names in French or English.
 */
export function readCategoryRules(file: string): Map<string, CategoryRule> {
  const rows = readCsv(file);
  const map = new Map<string, CategoryRule>();
  if (rows.length < 2) return map;
  const header = headerIndex(rows[0]!);
  const cCategory = column(
    header,
    'google category',
    'catégorie google',
    'categorie google',
    'category',
  );
  const cLabel = column(header, 'libellé', 'libelle', 'label');
  const cSpecialty = column(header, 'spécialité', 'specialite', 'specialty');
  const cExclude = column(header, 'exclure', 'exclude', 'exclusion');
  if (cCategory === null) {
    throw new RulesError(`${file}: no "Google category" column`);
  }
  const cell = (row: readonly unknown[], index: number | null): string | null => {
    if (index === null) return null;
    const value = row[index];
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text === '' ? null : text;
  };
  for (const row of rows.slice(1)) {
    const category = cell(row, cCategory);
    if (category === null) continue;
    map.set(fold(category), {
      label: cell(row, cLabel),
      specialty: cell(row, cSpecialty),
      exclude: cell(row, cExclude),
    });
  }
  return map;
}

interface ExclusionsFile {
  chains?: unknown;
  rules?: unknown;
}

const asStrings = (value: unknown, where: string): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' && typeof v !== 'number')) {
    throw new RulesError(`${where} must be a list of words`);
  }
  return value.map(String);
};

/** Read the exclusions file: `chains:` and `rules:` (reason, names, categories). */
export function readExclusions(file: string): Pick<QualifyRules, 'chains' | 'nameRules'> {
  let doc: ExclusionsFile;
  try {
    doc = (parseYaml(fs.readFileSync(file, 'utf8')) ?? {}) as ExclusionsFile;
  } catch (error) {
    throw new RulesError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const chains = asStrings(doc.chains, `${file}: chains`)
    .map((name) => ({ folded: fold(name), name }))
    .filter((c) => c.folded !== '');

  const rawRules = doc.rules ?? [];
  if (!Array.isArray(rawRules)) throw new RulesError(`${file}: rules must be a list`);
  const nameRules = rawRules.map((raw: unknown, i): NameRule => {
    const rule = (raw ?? {}) as Record<string, unknown>;
    const reason = rule['reason'];
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new RulesError(`${file}: rule ${i + 1} has no reason`);
    }
    const names = asStrings(rule['names'], `${file}: rule ${i + 1} names`).map(fold);
    const categories = asStrings(rule['categories'], `${file}: rule ${i + 1} categories`).map(fold);
    if (names.length === 0 && categories.length === 0) {
      throw new RulesError(`${file}: rule ${i + 1} needs names or categories`);
    }
    return {
      reason: reason.trim(),
      names: names.filter((n) => n !== ''),
      categories: categories.length > 0 ? new Set(categories) : null,
    };
  });
  return { chains, nameRules };
}

export function loadRules(options: {
  readonly categoriesFile?: string | undefined;
  readonly exclusionsFile?: string | undefined;
  readonly chainSiteThreshold: number;
  readonly activeAreasOnly: boolean;
}): QualifyRules {
  const exclusions =
    options.exclusionsFile === undefined
      ? { chains: [], nameRules: [] }
      : readExclusions(options.exclusionsFile);
  return {
    categories:
      options.categoriesFile === undefined ? new Map() : readCategoryRules(options.categoriesFile),
    ...exclusions,
    chainSiteThreshold: options.chainSiteThreshold,
    activeAreasOnly: options.activeAreasOnly,
  };
}
