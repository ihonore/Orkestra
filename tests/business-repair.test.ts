/**
 * Correcting businesses that were saved with another place's data.
 *
 * Before the extraction fix, names and websites came from network payloads
 * that could describe a different place, and 849 websites were Google Street
 * View images. A re-scrape has to be able to put that right — which an update
 * that keeps the stored value whenever the new one is empty could not do.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { BusinessesRepository, type BusinessInput } from '../src/db/repositories/businesses.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

function db(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 'repair.sqlite') });
  migrate(driver);
  return driver;
}

const BASE: BusinessInput = {
  cid: '123',
  fid: '0x1:0x7b',
  placeId: null,
  dedupHash: 'cid:123',
  name: 'Urgent Dental Relief',
  categoryPrimary: 'Car dealer',
  categoriesJson: null,
  rating: null,
  reviewsCount: null,
  phoneRaw: null,
  phoneE164: null,
  addressRaw: null,
  street: null,
  city: null,
  stateCode: null,
  postalCode: null,
  country: null,
  lat: null,
  lng: null,
  plusCode: null,
  websiteRaw: 'https://www.ihg.com',
  websiteUrl: 'https://www.ihg.com',
  domainId: null,
  gmapsUrl: null,
  thumbnailUrl: null,
  hoursJson: null,
  permanentlyClosed: false,
  extractionSource: null,
  rawJson: null,
  automationId: 'google-maps',
  runId: 'r1',
};

/** Link an address found by crawling `domainId` to the business. */
function linkEmail(driver: SqliteDriver, businessId: number, domainId: number, address: string) {
  const email = driver
    .prepare(
      `INSERT INTO emails (address, local_part, email_domain, first_seen_at) VALUES (?, 'x', 'y', 0)`,
    )
    .run([address]);
  driver
    .prepare(
      `INSERT INTO business_emails (business_id, email_id, source_url, source_domain_id, method,
                                    confidence, first_seen_at)
       VALUES (?, ?, 'https://x', ?, 'mailto', 1, 0)`,
    )
    .run([businessId, Number(email.lastInsertRowid), domainId]);
}

const linkCount = (driver: SqliteDriver, id: number) =>
  driver
    .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM business_emails WHERE business_id = ?`)
    .get([id])!.n;

describe('re-scraping a business saved with wrong data', () => {
  it('replaces a wrong name and website, and drops the wrong site’s emails', () => {
    const driver = db();
    const repo = new BusinessesRepository(driver);
    const wrong = repo.upsertDomain('ihg.com', false);
    const { id } = repo.upsert({ ...BASE, domainId: wrong });
    linkEmail(driver, id, wrong, 'reservations@ihg.com');

    const right = repo.upsertDomain('anchoragechevrolet.com', false);
    repo.upsert({
      ...BASE,
      name: 'Chevrolet of South Anchorage',
      websiteRaw: 'https://www.anchoragechevrolet.com',
      websiteUrl: 'https://www.anchoragechevrolet.com',
      domainId: right,
      websiteConfirmed: true,
    });

    const row = driver
      .prepare<{ name: string; website_url: string; domain_id: number }>(
        `SELECT name, website_url, domain_id FROM businesses WHERE id = ?`,
      )
      .get([id])!;
    expect(row).toEqual({
      name: 'Chevrolet of South Anchorage',
      website_url: 'https://www.anchoragechevrolet.com',
      domain_id: right,
    });
    expect(linkCount(driver, id)).toBe(0);
  });

  it('clears a wrong website when the listing has none', () => {
    const driver = db();
    const repo = new BusinessesRepository(driver);
    const { id } = repo.upsert({ ...BASE, domainId: repo.upsertDomain('ihg.com', false) });
    repo.upsert({
      ...BASE,
      websiteRaw: null,
      websiteUrl: null,
      domainId: null,
      websiteConfirmed: true,
    });
    expect(
      driver
        .prepare<{ w: string | null }>(`SELECT website_url AS w FROM businesses WHERE id = ?`)
        .get([id])!.w,
    ).toBeNull();
  });

  it('keeps the stored website when the page did not load far enough to say', () => {
    const driver = db();
    const repo = new BusinessesRepository(driver);
    const domain = repo.upsertDomain('ihg.com', false);
    const { id } = repo.upsert({ ...BASE, domainId: domain });
    linkEmail(driver, id, domain, 'a@ihg.com');
    repo.upsert({ ...BASE, websiteRaw: null, websiteUrl: null, domainId: null });
    expect(
      driver.prepare<{ d: number }>(`SELECT domain_id AS d FROM businesses WHERE id = ?`).get([id])!
        .d,
    ).toBe(domain);
    expect(linkCount(driver, id)).toBe(1);
  });

  it('keeps emails found on the site it still has', () => {
    const driver = db();
    const repo = new BusinessesRepository(driver);
    const domain = repo.upsertDomain('acme.com', false);
    const { id } = repo.upsert({ ...BASE, domainId: domain });
    linkEmail(driver, id, domain, 'owner@acme.com');
    repo.upsert({ ...BASE, domainId: domain, websiteConfirmed: true });
    expect(linkCount(driver, id)).toBe(1);
  });
});

describe('the Google-host repair migration', () => {
  it('clears Street View "websites" and never crawls them again', () => {
    const driver = openDatabase({ file: path.join(tempDir(), 'm.sqlite') });
    const all = loadMigrations();
    const before = all.filter((m) => m.version < '0008');
    // Apply everything up to the repair, write the bad data, then the repair.
    const dir = tempDir();
    for (const m of before) {
      fs.writeFileSync(path.join(dir, m.filename), m.sql);
    }
    migrate(driver, { dir });

    const repo = new BusinessesRepository(driver);
    const google = repo.upsertDomain('googleapis.com', false);
    const real = repo.upsertDomain('acme.com', false);
    const bad = repo.upsert({ ...BASE, domainId: google });
    const good = repo.upsert({ ...BASE, cid: '456', dedupHash: 'cid:456', domainId: real });
    linkEmail(driver, bad.id, google, 'x@googleapis.com');

    migrate(driver);

    const site = (id: number) =>
      driver
        .prepare<{ d: number | null }>(`SELECT domain_id AS d FROM businesses WHERE id = ?`)
        .get([id])!.d;
    expect(site(bad.id)).toBeNull();
    expect(site(good.id)).toBe(real);
    expect(linkCount(driver, bad.id)).toBe(0);
    expect(
      driver.prepare<{ s: string }>(`SELECT status AS s FROM domains WHERE id = ?`).get([google])!
        .s,
    ).toBe('skipped');
  });
});
