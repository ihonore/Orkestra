/**
 * The French lead sheet, and the opt-out list every export honours.
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { EmailsRepository } from '../src/db/repositories/emails.js';
import {
  LEADS_BY_BUSINESS,
  PROSPECTS,
  SHEET_LAYOUT_ENTITY,
  countRemaining,
  readPage,
  sheetTabFor,
  type ExportRow,
} from '../src/views/index.js';
import { rulesFromConfig, runQualification } from '../src/qualify/pass.js';
import { parseOptOut } from '../src/qualify/opt-out.js';
import { loadConfig } from '../src/config/loader.js';
import { campaignDir } from '../src/core/util/paths.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const config = loadConfig({ cwd: campaignDir('gobadiz'), env: {} });
const rules = rulesFromConfig(config);

function database(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 'p.sqlite') });
  migrate(driver);
  driver
    .prepare(
      `INSERT INTO cities (zip, city, state, state_code, lat, lng, active, created_at, updated_at)
       VALUES ('75011', 'Paris 11e', 'Paris', '75', 48.86, 2.38, 1, 0, 0)`,
    )
    .run();
  return driver;
}

let n = 0;
interface Salon {
  name: string;
  phone?: string;
  site?: { domain: string; url: string; status?: string; social?: boolean };
  instagram?: string;
  booking?: string;
  category?: string;
  region?: string;
}
function salon(driver: SqliteDriver, s: Salon): number {
  let domainId: number | null = null;
  if (s.site !== undefined) {
    domainId = driver
      .prepare<{ id: number }>(
        `INSERT INTO domains (domain, status, is_social, created_at) VALUES (?, ?, ?, 0) RETURNING id`,
      )
      .get([s.site.domain, s.site.status ?? 'done', s.site.social === true ? 1 : 0])!.id;
  }
  n += 1;
  return driver
    .prepare<{ id: number }>(
      `INSERT INTO businesses (dedup_hash, name, category_primary, phone_e164, phone_raw, street,
                               city, state_code, postal_code, website_url, domain_id, instagram_url,
                               booking_provider, rating, gmaps_url, automation_id, first_seen_at,
                               last_seen_at)
       VALUES (?, ?, ?, ?, ?, '12 Rue de Charonne', 'Paris 11e', ?, '75011', ?, ?, ?, ?, 4.8,
               'https://maps.google.com/x', 'google-maps', 1794000000000, 0)
       RETURNING id`,
    )
    .get([
      `p${n}`,
      s.name,
      s.category ?? 'Nail salon',
      s.phone ?? null,
      s.phone ?? null,
      s.region ?? '75',
      s.site?.url ?? null,
      domainId,
      s.instagram ?? null,
      s.booking ?? null,
    ])!.id;
}

function email(driver: SqliteDriver, businessId: number, address: string, isRole = false): void {
  const [local, domain] = address.split('@') as [string, string];
  const emailId = driver
    .prepare<{ id: number }>(
      `INSERT INTO emails (address, local_part, email_domain, is_role, first_seen_at)
       VALUES (?, ?, ?, ?, 0) RETURNING id`,
    )
    .get([address, local, domain, isRole ? 1 : 0])!.id;
  driver
    .prepare(
      `INSERT INTO business_emails (business_id, email_id, source_url, method, confidence, first_seen_at)
       VALUES (?, ?, 'https://x', 'mailto', 1, 0)`,
    )
    .run([businessId, emailId]);
}

function sheet(driver: SqliteDriver, lastId = 0): ExportRow[] {
  runQualification(driver, rules);
  return readPage(driver, PROSPECTS, { lastId, lastSubId: 0 }, 100).rows;
}

describe('the Gobadiz sheet', () => {
  it('has French headers, with blank Statut and Notes for the team', () => {
    expect(PROSPECTS.fields.map((f) => f.name)).toEqual([
      'Priorité',
      'Spécialité',
      'Nom',
      'Catégorie',
      'Ville',
      'Code postal',
      'Adresse',
      'Téléphone',
      'Portable',
      'Email',
      'Autres emails',
      'Instagram',
      'Site web',
      'Réservation en ligne',
      'Sur RDV',
      'Note',
      'Trouvé via',
      'Google Maps',
      'Ajouté le',
      'Statut',
      'Notes',
    ]);
  });

  it('sends a phone-only nail technician, first in line', () => {
    const driver = database();
    salon(driver, {
      name: 'Nina Nails',
      phone: '+33612345678',
      instagram: 'https://www.instagram.com/nina/',
    });
    const [row] = sheet(driver);
    expect(row).toMatchObject({
      Priorité: 'A',
      Spécialité: 'Onglerie',
      Nom: 'Nina Nails',
      Catégorie: 'Onglerie',
      Ville: 'Paris 11e',
      'Code postal': '75011',
      Téléphone: '06 12 34 56 78',
      Portable: 'oui',
      Email: null,
      Instagram: 'https://www.instagram.com/nina/',
      Statut: null,
    });
    driver.close();
  });

  it('ranks a salon already on Planity last, and one with no signals in between', () => {
    const driver = database();
    salon(driver, { name: 'Sur Planity', phone: '+33612345678', booking: 'Planity' });
    salon(driver, { name: 'Fixe seulement', phone: '+33142334455' });
    salon(driver, { name: 'Son propre site', booking: 'own site' });
    const rows = sheet(driver);
    expect(rows.map((r) => [r['Nom'], r['Priorité'], r['Réservation en ligne']])).toEqual([
      ['Sur Planity', 'C', 'Planity'],
      ['Fixe seulement', 'B', null],
      ['Son propre site', 'C', 'Site du salon'],
    ]);
    expect(rows[1]!['Téléphone']).toBe('01 42 33 44 55');
    driver.close();
  });

  it('gives the best address first, the rest after, and never an opted-out one', () => {
    const driver = database();
    const id = salon(driver, {
      name: 'Salon Aminata',
      site: { domain: 'salon-aminata.fr', url: 'https://salon-aminata.fr' },
    });
    email(driver, id, 'contact@salon-aminata.fr', true);
    email(driver, id, 'aminata@salon-aminata.fr');
    email(driver, id, 'old@salon-aminata.fr');
    new EmailsRepository(driver).addSuppression('email', 'old@salon-aminata.fr');
    const [row] = sheet(driver);
    expect(row).toMatchObject({
      Email: 'aminata@salon-aminata.fr',
      'Autres emails': 'contact@salon-aminata.fr',
      'Site web': 'https://salon-aminata.fr',
    });
    driver.close();
  });

  it('waits for a website to be crawled, then sends the lead once', () => {
    const driver = database();
    salon(driver, { name: 'Déjà prêt' });
    salon(driver, {
      name: 'Pas encore',
      site: { domain: 'pasencore.fr', url: 'https://pasencore.fr', status: 'pending' },
    });
    const first = sheet(driver);
    expect(first.map((r) => r['Nom'])).toEqual(['Déjà prêt']);
    const cursor = first.at(-1)!['id'] as number;

    driver.prepare(`UPDATE domains SET status = 'done' WHERE domain = 'pasencore.fr'`).run();
    expect(sheet(driver, cursor).map((r) => r['Nom'])).toEqual(['Pas encore']);
    // Nothing is sent twice.
    runQualification(driver, rules);
    expect(countRemaining(driver, PROSPECTS, { lastId: cursor + 1, lastSubId: 0 })).toBe(0);
    driver.close();
  });

  it('leaves out unwanted and opted-out businesses', () => {
    const driver = database();
    salon(driver, { name: 'Franck Provost Bastille', category: 'Hair salon' });
    salon(driver, { name: 'Hors Paris', region: '93' });
    salon(driver, { name: 'Ne plus appeler', phone: '+33612345678' });
    salon(driver, { name: 'Gardé' });
    new EmailsRepository(driver).addSuppression('phone', '+33612345678');
    expect(sheet(driver).map((r) => r['Nom'])).toEqual(['Gardé']);
    driver.close();
  });

  it('shows a booking page given as the website as booking, not as a site', () => {
    const driver = database();
    salon(driver, {
      name: 'Rapunzel',
      site: {
        domain: 'planity.com',
        url: 'https://www.planity.com/rapunzel',
        status: 'skipped',
        social: true,
      },
      booking: 'Planity',
    });
    expect(sheet(driver)[0]).toMatchObject({ 'Site web': null, 'Réservation en ligne': 'Planity' });
    driver.close();
  });

  it('is what the Gobadiz campaign sends, to its own tab, without rebuilding', () => {
    const sheets = config.exporters.sheets;
    expect(SHEET_LAYOUT_ENTITY[sheets.layout]).toBe('prospects');
    expect(sheetTabFor(sheets, 'prospects')).toBe('Prospects');
    expect(sheets.rebuildOnRescrape).toBe(false);
    const main = loadConfig({ cwd: tempDir(), env: {} }).exporters.sheets;
    expect(main.rebuildOnRescrape).toBe(true);
    expect(sheetTabFor(main, 'leads-by-business')).toBe('Leads by business');
  });
});

describe('opt-outs', () => {
  it('reads whatever the team pastes', () => {
    expect(parseOptOut('Contact@MonSalon.fr', 'FR')).toEqual({
      kind: 'email',
      value: 'contact@monsalon.fr',
    });
    expect(parseOptOut('mailto:a@b.fr', 'FR')).toEqual({ kind: 'email', value: 'a@b.fr' });
    expect(parseOptOut('06 12 34 56 78', 'FR')).toEqual({ kind: 'phone', value: '+33612345678' });
    expect(parseOptOut('+33 1 42 33 44 55', 'FR')).toEqual({
      kind: 'phone',
      value: '+33142334455',
    });
    expect(parseOptOut('https://www.monsalon.fr/contact', 'FR')).toEqual({
      kind: 'domain',
      value: 'monsalon.fr',
    });
    expect(parseOptOut('monsalon.fr', 'FR')).toEqual({ kind: 'domain', value: 'monsalon.fr' });
    expect(parseOptOut('(205) 202-1320', 'US')).toEqual({ kind: 'phone', value: '+12052021320' });
    expect(parseOptOut('pas une adresse', 'FR')).toBeNull();
    expect(parseOptOut('', 'FR')).toBeNull();
  });

  it('removes a business from the US lead export too', () => {
    const driver = database();
    const id = salon(driver, {
      name: 'Acme',
      site: { domain: 'acme.com', url: 'https://acme.com' },
    });
    email(driver, id, 'owner@acme.com');
    const before = readPage(driver, LEADS_BY_BUSINESS, { lastId: 0, lastSubId: 0 }, 10).rows;
    expect(before).toHaveLength(1);
    const emails = new EmailsRepository(driver);
    emails.addSuppression('domain', 'acme.com');
    expect(readPage(driver, LEADS_BY_BUSINESS, { lastId: 0, lastSubId: 0 }, 10).rows).toHaveLength(
      0,
    );
    expect(emails.removeSuppression('domain', 'acme.com')).toBe(true);
    expect(emails.listSuppressions()).toEqual([]);
    driver.close();
  });
});
