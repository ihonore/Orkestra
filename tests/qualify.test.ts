/**
 * Qualification: which businesses a campaign wants, and when a lead is ready.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import {
  fold,
  loadRules,
  qualify,
  readExclusions,
  RulesError,
  type QualifyInput,
  type QualifyRules,
} from '../src/qualify/rules.js';
import { rulesFromConfig, runQualification } from '../src/qualify/pass.js';
import { loadConfig } from '../src/config/loader.js';
import { campaignDir } from '../src/core/util/paths.js';
import { parseCategoryRows } from '../src/importers/seeds.js';
import { readCsv } from '../src/importers/xlsx.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

afterEach(cleanupTempDirs);

const GOBADIZ = campaignDir('gobadiz');
const gobadizRules = (): QualifyRules => rulesFromConfig(loadConfig({ cwd: GOBADIZ, env: {} }));

function salon(overrides: Partial<QualifyInput> = {}): QualifyInput {
  return {
    name: 'Nathou Tresses',
    category: 'Hair salon',
    region: '75',
    permanentlyClosed: false,
    searchSpecialty: 'Coiffure',
    siteDomain: null,
    siteListings: 0,
    ...overrides,
  };
}

const PARIS = new Set(['75']);

describe('the Gobadiz rules', () => {
  const rules = gobadizRules();
  const reason = (input: Partial<QualifyInput>): string | null =>
    qualify(salon(input), rules, PARIS).exclusionReason;

  it('wants an independent Paris salon, in its specialty and French label', () => {
    expect(qualify(salon(), rules, PARIS)).toEqual({
      specialty: 'Coiffure',
      categoryLabel: 'Salon de coiffure',
      exclusionReason: null,
    });
    const nails = qualify(salon({ category: 'Nail salon', searchSpecialty: null }), rules, PARIS);
    expect(nails).toMatchObject({ specialty: 'Onglerie', categoryLabel: 'Onglerie' });
  });

  it('takes a generic category’s specialty from the search that found it', () => {
    const result = qualify(
      salon({ category: 'Beauty salon', searchSpecialty: 'Onglerie' }),
      rules,
      PARIS,
    );
    expect(result).toMatchObject({ specialty: 'Onglerie', categoryLabel: 'Institut de beauté' });
  });

  it('leaves out chains, however their name is written', () => {
    expect(reason({ name: 'JEAN-LOUIS DAVID - Coiffeur Paris 11' })).toBe(
      'Chaîne (Jean Louis David)',
    );
    expect(reason({ name: 'Franck Provost Bastille' })).toBe('Chaîne (Franck Provost)');
    expect(reason({ name: 'Body minute Paris 18', category: 'Beauty salon' })).toBe(
      'Chaîne (Body Minute)',
    );
    // Whole words only.
    expect(reason({ name: 'Les Tchipies Nails' })).toBeNull();
  });

  it('leaves out a chain no list names, by the website its listings share', () => {
    expect(reason({ siteDomain: 'blackboxparis.com', siteListings: 3 })).toBe(
      'Chaîne (3 fiches, même site blackboxparis.com)',
    );
    expect(reason({ siteDomain: 'blackboxparis.com', siteListings: 2 })).toBeNull();
  });

  it('leaves out hotel spas, but not a salon near the Hôtel de Ville', () => {
    expect(reason({ name: 'Spa du Grand Hôtel', category: 'Day spa' })).toBe(
      "Spa d'hôtel ou thalasso",
    );
    expect(reason({ name: 'Thalasso Paris', category: 'Massage spa' })).toBe(
      "Spa d'hôtel ou thalasso",
    );
    expect(reason({ name: 'Coiffure Hôtel de Ville' })).toBeNull();
  });

  it('leaves out medical aesthetics, tattoo studios and erotic massage', () => {
    expect(reason({ name: 'Dr Martin médecine esthétique', category: 'Beauty salon' })).toBe(
      'Esthétique médicale',
    );
    expect(reason({ category: 'Medical spa' })).toBe('Esthétique médicale');
    expect(reason({ name: 'Ink Tattoo Studio', category: 'Tattoo shop' })).toBe(
      'Tatouage / piercing',
    );
    expect(reason({ name: 'Massage Tantrique Paris', category: 'Massage therapist' })).toBe(
      'Massage érotique',
    );
  });

  it('keeps laser hair removal, which Gobadiz offers', () => {
    expect(reason({ name: 'Centre Laser Épilation', category: 'Laser hair removal service' })).toBe(
      null,
    );
  });

  it('leaves out shops, schools and closed salons', () => {
    expect(reason({ category: 'Cosmetics store' })).toBe('Magasin (pas un salon)');
    expect(reason({ category: 'Barber school' })).toBe('École');
    expect(reason({ permanentlyClosed: true })).toBe('Fermé définitivement');
  });

  it('holds back a suburb until its département is switched on', () => {
    expect(reason({ region: '93' })).toBe('Hors zone (93)');
    expect(qualify(salon({ region: '93' }), rules, new Set(['75', '93'])).exclusionReason).toBe(
      null,
    );
    // No postcode on the listing: kept, since where it is cannot be told.
    expect(reason({ region: null })).toBeNull();
  });

  it('gives every Gobadiz search term a specialty from the Gobadiz catalogue', () => {
    const parsed = parseCategoryRows(readCsv(path.join(GOBADIZ, 'seeds', 'services.csv')));
    expect(parsed.rejected).toEqual([]);
    const catalogue = new Set([
      'Coiffure',
      'Barbier',
      'Onglerie',
      'Esthétique',
      'Maquillage',
      'Massage',
    ]);
    for (const service of parsed.categories) {
      expect(catalogue.has(service.specialty ?? ''), service.name).toBe(true);
    }
  });
});

describe('rule files', () => {
  it('folds names for comparison', () => {
    expect(fold("L'Atelier du Sourcil — Paris 11ᵉ")).toBe('l atelier du sourcil paris 11e');
  });

  it('refuses a rule without a reason, naming the file and rule', () => {
    const dir = tempDir();
    writeFile(dir, 'x.yaml', 'rules:\n  - names: [foo]\n');
    expect(() => readExclusions(path.join(dir, 'x.yaml'))).toThrow(RulesError);
    expect(() => readExclusions(path.join(dir, 'x.yaml'))).toThrow(/rule 1 has no reason/);
  });

  it('works with no files at all', () => {
    const rules = loadRules({ chainSiteThreshold: 3, activeAreasOnly: false });
    expect(qualify(salon(), rules, new Set()).exclusionReason).toBeNull();
  });
});

describe('the qualification pass', () => {
  function database(): SqliteDriver {
    const driver = openDatabase({ file: path.join(tempDir(), 'q.sqlite') });
    migrate(driver);
    driver
      .prepare(
        `INSERT INTO cities (zip, city, state, state_code, lat, lng, active, created_at, updated_at)
         VALUES ('75011', 'Paris 11e', 'Paris', '75', 48.86, 2.38, 1, 0, 0),
                ('93100', 'Montreuil', 'Seine-Saint-Denis', '93', 48.86, 2.44, 0, 0, 0)`,
      )
      .run();
    return driver;
  }

  let n = 0;
  function business(
    driver: SqliteDriver,
    name: string,
    options: { domain?: string; status?: string; social?: boolean; region?: string } = {},
  ): number {
    let domainId: number | null = null;
    if (options.domain !== undefined) {
      domainId =
        driver
          .prepare<{ id: number }>(`SELECT id FROM domains WHERE domain = ?`)
          .get([options.domain])?.id ?? null;
      domainId ??= driver
        .prepare<{ id: number }>(
          `INSERT INTO domains (domain, status, is_social, created_at) VALUES (?, ?, ?, 0) RETURNING id`,
        )
        .get([options.domain, options.status ?? 'pending', options.social === true ? 1 : 0])!.id;
    }
    n += 1;
    return driver
      .prepare<{ id: number }>(
        `INSERT INTO businesses (dedup_hash, name, category_primary, state_code, domain_id,
                                 automation_id, first_seen_at, last_seen_at)
         VALUES (?, ?, 'Hair salon', ?, ?, 'google-maps', 0, 0) RETURNING id`,
      )
      .get([`h${n}`, name, options.region ?? '75', domainId])!.id;
  }

  const row = (driver: SqliteDriver, id: number) =>
    driver
      .prepare<{ lead_seq: number | null; exclusion_reason: string | null }>(
        `SELECT lead_seq, exclusion_reason FROM businesses WHERE id = ?`,
      )
      .get([id])!;

  it('hands out a lead once its email search is over, phone-only leads included', () => {
    const driver = database();
    const noSite = business(driver, 'Sans Site');
    const instagram = business(driver, 'Insta', {
      domain: 'instagram.com',
      status: 'skipped',
      social: true,
    });
    const crawled = business(driver, 'Crawled', { domain: 'crawled.fr', status: 'done' });
    const waiting = business(driver, 'Waiting', { domain: 'waiting.fr' });

    const report = runQualification(driver, gobadizRules());
    expect(report.newlyReady).toBe(3);
    expect(report.waitingForEmails).toBe(1);
    expect([noSite, instagram, crawled].map((id) => row(driver, id).lead_seq)).toEqual([1, 2, 3]);
    expect(row(driver, waiting).lead_seq).toBeNull();

    // Its site crawled, the last one gets the next number; the others keep theirs.
    driver.prepare(`UPDATE domains SET status = 'done' WHERE domain = 'waiting.fr'`).run();
    expect(runQualification(driver, gobadizRules()).newlyReady).toBe(1);
    expect(row(driver, waiting).lead_seq).toBe(4);
    expect(row(driver, noSite).lead_seq).toBe(1);
    driver.close();
  });

  it("takes an unwanted business's site out of the crawl, and puts it back", () => {
    const driver = database();
    const suburb = business(driver, 'Salon Montreuil', {
      domain: 'montreuil-salon.fr',
      region: '93',
    });

    const first = runQualification(driver, gobadizRules());
    expect(first.sitesRetired).toBe(1);
    expect(row(driver, suburb)).toEqual({ lead_seq: null, exclusion_reason: 'Hors zone (93)' });
    const status = () =>
      driver
        .prepare<{ status: string }>(
          `SELECT status FROM domains WHERE domain = 'montreuil-salon.fr'`,
        )
        .get()!.status;
    expect(status()).toBe('skipped');

    // The 93 is switched on: the salon is wanted, and its site is crawled.
    driver.prepare(`UPDATE cities SET active = 1 WHERE state_code = '93'`).run();
    const second = runQualification(driver, gobadizRules());
    expect(second.sitesRestored).toBe(1);
    expect(status()).toBe('pending');
    expect(row(driver, suburb).exclusion_reason).toBeNull();
    driver.close();
  });

  it('never revives a site skipped for another reason', () => {
    const driver = database();
    business(driver, 'Insta', { domain: 'instagram.com', status: 'skipped', social: true });
    expect(runQualification(driver, gobadizRules()).sitesRestored).toBe(0);
    driver.close();
  });

  it('reports why businesses were left out', () => {
    const driver = database();
    business(driver, 'Franck Provost Bastille');
    business(driver, 'Salon Montreuil', { region: '93' });
    business(driver, 'Salon Bobigny', { region: '93' });
    const report = runQualification(driver, gobadizRules());
    expect(report.reasons).toEqual([
      { reason: 'Hors zone', count: 2 },
      { reason: 'Chaîne', count: 1 },
    ]);
    driver.close();
  });
});
