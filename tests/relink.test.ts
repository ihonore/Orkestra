/**
 * Filing stored websites under today's rules.
 *
 * Seen on the Gobadiz Paris run: 150 independent salons whose "website" was
 * a booking page (setmore.com, reservio.com) or a site builder (now.site,
 * book.fr) shared one domain row per host. The qualification took each host
 * for a chain's site, and the one crawl of the row pinned a single salon's
 * address — or the platform's — on all of them.
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { domainOf } from '../src/automations/google-maps/normalize.js';
import { loadConfig } from '../src/config/loader.js';
import { mergeProviders } from '../src/core/util/business-links.js';
import { campaignDir } from '../src/core/util/paths.js';
import { openDatabase } from '../src/db/client.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { migrate } from '../src/db/migrate.js';
import { validateEmail } from '../src/enrichment/website-emails/validate/rules.js';
import { rulesFromConfig, runQualification } from '../src/qualify/pass.js';
import { foundOnOwnPage, relinkWebsites } from '../src/qualify/relink.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

function database(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 'relink.sqlite') });
  migrate(driver);
  driver
    .prepare(
      `INSERT INTO cities (zip, city, state, state_code, lat, lng, active, created_at, updated_at)
       VALUES ('75011', 'Paris 11e', 'Paris', '75', 48.86, 2.38, 1, 0, 0)`,
    )
    .run();
  return driver;
}

/** A domain row as the old rules filed it: by registrable domain, crawled. */
function domain(driver: SqliteDriver, name: string, status = 'done'): number {
  return (
    driver.prepare<{ id: number }>(`SELECT id FROM domains WHERE domain = ?`).get([name])?.id ??
    driver
      .prepare<{ id: number }>(
        `INSERT INTO domains (domain, status, is_social, created_at) VALUES (?, ?, 0, 0) RETURNING id`,
      )
      .get([name, status])!.id
  );
}

let n = 0;
function salon(
  driver: SqliteDriver,
  name: string,
  website: string,
  domainId: number,
  booking: string | null = null,
): number {
  n += 1;
  return driver
    .prepare<{ id: number }>(
      `INSERT INTO businesses (dedup_hash, name, category_primary, state_code, website_url,
                               domain_id, booking_provider, automation_id, first_seen_at, last_seen_at)
       VALUES (?, ?, 'Hair salon', '75', ?, ?, ?, 'google-maps', 0, 0) RETURNING id`,
    )
    .get([`h${n}`, name, website, domainId, booking])!.id;
}

/** Link an address the crawl of `domainId` found at `sourceUrl`. */
function found(
  driver: SqliteDriver,
  businessId: number,
  address: string,
  sourceUrl: string,
  domainId: number,
): void {
  const emailId =
    driver.prepare<{ id: number }>(`SELECT id FROM emails WHERE address = ?`).get([address])?.id ??
    driver
      .prepare<{ id: number }>(
        `INSERT INTO emails (address, local_part, email_domain, first_seen_at)
         VALUES (?, ?, ?, 0) RETURNING id`,
      )
      .get([address, address.split('@')[0]!, address.split('@')[1]!])!.id;
  driver
    .prepare(
      `INSERT INTO business_emails (business_id, email_id, source_url, source_domain_id, method,
                                    confidence, first_seen_at)
       VALUES (?, ?, ?, ?, 'mailto', 0.7, 0)`,
    )
    .run([businessId, emailId, sourceUrl, domainId]);
}

const emailsOf = (driver: SqliteDriver, businessId: number): string[] =>
  driver
    .prepare<{ address: string }>(
      `SELECT e.address FROM business_emails be JOIN emails e ON e.id = be.email_id
        WHERE be.business_id = ? ORDER BY e.address`,
    )
    .all([businessId])
    .map((r) => r.address);

const business = (driver: SqliteDriver, id: number) =>
  driver
    .prepare<{
      domain: string | null;
      is_social: number | null;
      status: string | null;
      booking_provider: string | null;
      exclusion_reason: string | null;
    }>(
      `SELECT d.domain, d.is_social, d.status, b.booking_provider, b.exclusion_reason
         FROM businesses b LEFT JOIN domains d ON d.id = b.domain_id WHERE b.id = ?`,
    )
    .get([id])!;

const gobadizRules = () => rulesFromConfig(loadConfig({ cwd: campaignDir('gobadiz'), env: {} }));

describe('websites filed under newer rules', () => {
  it('stops taking salons on one booking platform for a chain', () => {
    const driver = database();
    const setmore = domain(driver, 'setmore.com');
    const twisted = salon(driver, 'Twisted Braids', 'https://twistedbraids.setmore.com', setmore);
    const palma = salon(driver, 'Studio Palma', 'https://studiopalma.setmore.com', setmore);
    const dede = salon(driver, 'Studio by Dede', 'https://studiobydede.setmore.com', setmore);
    // The one crawl of the shared row started at Twisted Braids' page.
    for (const id of [twisted, palma, dede]) {
      found(
        driver,
        id,
        'management@twistedbraids.fr',
        'https://twistedbraids.setmore.com/',
        setmore,
      );
    }

    // Before: three listings, one "website" — a chain.
    expect(runQualification(driver, gobadizRules()).excluded).toBe(3);

    const report = relinkWebsites(driver, domainOf);
    expect(report).toMatchObject({ moved: 0, notWebsites: 1, linksDropped: 2 });
    expect(business(driver, twisted)).toMatchObject({
      is_social: 1,
      booking_provider: 'Setmore',
    });
    // The address stays with the salon whose page it was on, and only that one.
    expect(emailsOf(driver, twisted)).toEqual(['management@twistedbraids.fr']);
    expect(emailsOf(driver, palma)).toEqual([]);
    expect(emailsOf(driver, dede)).toEqual([]);

    expect(runQualification(driver, gobadizRules()).excluded).toBe(0);
    driver.close();
  });

  it('gives each site on a site builder its own row, to be crawled', () => {
    const driver = database();
    const book = domain(driver, 'book.fr');
    const bleu = salon(driver, 'Bleu Marine FX', 'https://bleumarinefx.book.fr', book);
    const camille = salon(driver, 'Camille MUA', 'https://camillejeansonmua.book.fr', book);
    found(driver, bleu, 'bleumarinefx@gmail.com', 'https://bleumarinefx.book.fr/contact', book);
    found(driver, camille, 'bleumarinefx@gmail.com', 'https://bleumarinefx.book.fr/contact', book);

    const report = relinkWebsites(driver, domainOf);
    expect(report).toMatchObject({ moved: 2, notWebsites: 0, linksDropped: 1 });
    expect(business(driver, bleu)).toMatchObject({
      domain: 'bleumarinefx.book.fr',
      is_social: 0,
      status: 'pending',
    });
    expect(business(driver, camille)).toMatchObject({
      domain: 'camillejeansonmua.book.fr',
      status: 'pending',
    });
    expect(emailsOf(driver, bleu)).toEqual(['bleumarinefx@gmail.com']);
    expect(emailsOf(driver, camille)).toEqual([]);

    // The kept link now belongs to the salon's own row, so a re-scrape that
    // confirms the website does not drop it as someone else's.
    const source = driver
      .prepare<{ domain: string }>(
        `SELECT d.domain FROM business_emails be JOIN domains d ON d.id = be.source_domain_id
          WHERE be.business_id = ?`,
      )
      .get([bleu])!.domain;
    expect(source).toBe('bleumarinefx.book.fr');
    driver.close();
  });

  it('reads "own site" as the platform when the website is one', () => {
    const driver = database();
    const simplybook = domain(driver, 'simplybook.it');
    const mermaid = salon(
      driver,
      'Mermaid Nails',
      'https://mermaidnail.simplybook.it',
      simplybook,
      'own site',
    );
    const planity = domain(driver, 'monsalon.fr');
    const own = salon(driver, 'Mon Salon', 'https://monsalon.fr', planity, 'Planity, own site');

    relinkWebsites(driver, domainOf);
    expect(business(driver, mermaid).booking_provider).toBe('SimplyBook');
    expect(business(driver, own).booking_provider).toBe('Planity, own site');
    driver.close();
  });

  it('changes nothing the second time', () => {
    const driver = database();
    const resalib = domain(driver, 'resalib.fr');
    salon(driver, 'Kobido', 'https://resalib.fr/p/89245', resalib, 'resalib.fr');
    salon(driver, 'BodyCup', 'https://www.resalib.fr/praticien/47272-bodycup', resalib);
    expect(relinkWebsites(driver, domainOf).bookingUpdated).toBe(2);
    expect(relinkWebsites(driver, domainOf)).toEqual({
      moved: 0,
      notWebsites: 0,
      linksDropped: 0,
      bookingUpdated: 0,
    });
    driver.close();
  });
});

describe('what counts as a website', () => {
  it('knows the booking platforms, links and directories salons list as their site', () => {
    for (const url of [
      'https://anna-beaute.reservio.com/booking',
      'https://www.uala.fr/salon-prestige/widget',
      'https://trea.tw/74jnyvjNtLqrFSd7q',
      'https://wa.me/message/326LU2ZYV3UJD1',
      'https://treatwellapp.page.link/vt4MX',
      'https://frmaps.xyz/business/nenuphar-nails-7ivluk_A',
      'https://fulaniparis.as.me/',
    ]) {
      expect(domainOf(url)?.isSocial, url).toBe(true);
    }
  });

  it('files a site-builder site by its own host', () => {
    expect(domainOf('https://alinrelaxation-paris.now.site/home')).toEqual({
      domain: 'alinrelaxation-paris.now.site',
      isSocial: false,
    });
    expect(domainOf('http://lesoleil.site-solocal.com')?.domain).toBe('lesoleil.site-solocal.com');
  });

  it('names providers stored by their domain', () => {
    expect(mergeProviders('own site, setmore.com', 'Planity')).toBe('Setmore, Planity, own site');
    expect(mergeProviders(null, null)).toBeNull();
  });

  it("keeps an address only from the salon's own page on a shared host", () => {
    const sumup = 'sumupbookings.com';
    const gaphas = 'https://www.sumupbookings.com/les-gaphas-236-barbershop';
    expect(foundOnOwnPage(gaphas, gaphas, sumup)).toBe(true);
    expect(foundOnOwnPage(gaphas, 'https://www.sumupbookings.com/brown-beauty', sumup)).toBe(false);
    // The platform's home page is everyone's.
    expect(foundOnOwnPage('https://www.uala.fr/contact', 'https://www.uala.fr', 'uala.fr')).toBe(
      false,
    );
  });

  it("rejects a booking platform's own addresses", () => {
    expect(validateEmail('contact@resalib.com').junkReason).toBe('vendor_telemetry');
    expect(validateEmail('support@setmore.com').junkReason).toBe('vendor_telemetry');
  });
});
