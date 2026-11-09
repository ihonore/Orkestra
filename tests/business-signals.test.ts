/**
 * Instagram, booking platforms and "by appointment": what a beauty campaign
 * needs to know about a salon beyond its phone and email.
 *
 * The payloads under fixtures/fr are real Maps responses for Paris salons,
 * captured in November 2026.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyLink,
  instagramProfile,
  saysByAppointment,
  signalsFrom,
} from '../src/core/util/business-links.js';
import { extractFromUrl } from '../src/automations/google-maps/extract/from-url.js';
import { extractFromXhr, parseXhrBody } from '../src/automations/google-maps/extract/from-xhr.js';
import { mergeExtractions } from '../src/automations/google-maps/extract/merge.js';
import type { DomExtraction } from '../src/automations/google-maps/extract/from-dom.js';
import { domainOf } from '../src/automations/google-maps/normalize.js';
import { crawlDomain } from '../src/enrichment/website-emails/crawler.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fr');
const INDEX = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8')) as {
  file: string;
  placeUrl: string;
  name: string;
}[];

/** Merge one captured listing the way the scraper does, panel left empty. */
function listing(file: string, panel: Partial<DomExtraction> = {}) {
  const entry = INDEX.find((e) => e.file === file);
  if (entry === undefined) throw new Error(`no fixture ${file}`);
  const url = extractFromUrl(entry.placeUrl);
  const payload = parseXhrBody(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  return mergeExtractions({
    url,
    xhr: extractFromXhr(payload, { fid: url.fid, cid: url.cid }, 'FR'),
    dom: {
      name: entry.name,
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
      ...panel,
    },
    gmapsUrl: entry.placeUrl,
    country: 'FR',
  }).business;
}

describe('links', () => {
  it('names the booking platforms salons use', () => {
    expect(classifyLink('https://www.planity.com/rapunzel-75011-paris?rwg_token=abc')).toEqual({
      kind: 'booking',
      provider: 'Planity',
      url: 'https://www.planity.com/rapunzel-75011-paris',
    });
    expect(classifyLink('https://23-nail-salon.mytreatwell.fr/')).toMatchObject({
      provider: 'Treatwell',
    });
    expect(classifyLink('https://widget.treatwell.fr/salon/x')).toMatchObject({
      provider: 'Treatwell',
    });
  });

  it("calls a Google booking link to the salon's own site its own booking", () => {
    expect(
      classifyLink('https://www.jenniferyao.com/reserver?rwg_token=x', 'jenniferyao.com'),
    ).toMatchObject({ provider: 'own site' });
    // An unknown platform is reported by its domain, so it can be added later.
    expect(classifyLink('https://rdv.example.fr/x?rwg_token=x', 'salon.fr')).toMatchObject({
      provider: 'example.fr',
    });
    // Without Google's token, an unknown link is just a link.
    expect(classifyLink('https://example.fr/contact', 'salon.fr')).toBeNull();
  });

  it('keeps Instagram profiles, not posts or the home page', () => {
    expect(instagramProfile('https://www.instagram.com/MeetNails75018/?hl=fr')).toBe(
      'https://www.instagram.com/meetnails75018/',
    );
    expect(instagramProfile('https://instagram.com/p/Cx123/')).toBeNull();
    expect(instagramProfile('https://www.instagram.com/')).toBeNull();
    expect(instagramProfile('https://www.instagram.com/explore/tags/tresses')).toBeNull();
  });

  it('lists every platform, named ones before the salon site', () => {
    const signals = signalsFrom(
      [
        'https://salon.fr/rdv?rwg_token=1',
        'https://www.fresha.com/a/x?rwg_token=2',
        'https://www.planity.com/x?rwg_token=3',
        'https://www.planity.com/x',
      ],
      'salon.fr',
    );
    expect(signals.bookingProvider).toBe('Fresha, Planity, own site');
    expect(signals.bookingUrl).toBe('https://www.fresha.com/a/x');
  });

  it('never crawls a booking platform or link page for email', () => {
    expect(domainOf('https://www.planity.com/rapunzel-75011-paris')?.isSocial).toBe(true);
    expect(domainOf('https://23-nail-salon.mytreatwell.fr/')?.isSocial).toBe(true);
    expect(domainOf('https://linktr.ee/salon')?.isSocial).toBe(true);
    expect(domainOf('https://www.fairychairstudio.com/')?.isSocial).toBe(false);
  });

  it('reads "by appointment" in French and English', () => {
    expect(saysByAppointment('Barbier sur RDV')).toBe(true);
    expect(saysByAppointment('Uniquement sur rendez-vous')).toBe(true);
    expect(saysByAppointment('Ouvert sur rendez vous le dimanche')).toBe(true);
    expect(saysByAppointment('By appointment only')).toBe(true);
    expect(saysByAppointment('Prendre rendez-vous')).toBe(false);
    expect(saysByAppointment('Barber XVIII')).toBe(false);
  });
});

describe('real Paris listings', () => {
  it('finds every platform a salon books through', () => {
    expect(listing('planity-and-glaura.xhr.txt').bookingProvider).toBe('Planity, Glaura');
    expect(listing('iwana-rated-5.xhr.txt').bookingProvider).toBe('Iwana');
  });

  it('recognises a salon booking through its own site', () => {
    const business = listing('own-site-booking.xhr.txt', {
      website: 'https://www.jenniferyao.com/',
    });
    expect(business.bookingProvider).toBe('own site');
  });

  it('takes Instagram from the listing', () => {
    expect(listing('instagram-action.xhr.txt').instagramUrl).toBe(
      'https://www.instagram.com/meetnails75018/',
    );
  });

  it('treats a Planity page given as the website as a booking platform', () => {
    const business = listing('planity-website.xhr.txt', {
      website: 'https://www.planity.com/le-barbier-de-montmartre-75018-paris',
    });
    expect(business.bookingProvider).toContain('Planity');
    expect(business.domainIsSocial).toBe(true);
  });

  it('reports nothing for a salon without online booking', () => {
    const business = listing('no-booking.xhr.txt');
    expect(business.bookingProvider).toBeNull();
    expect(business.instagramUrl).toBeNull();
  });

  it('reads a whole-number rating, not the longitude beside it', () => {
    // This salon is rated 5, stored as an integer. The old search for "any
    // decimal from 0 to 5" skipped it and returned 2.3847485, Paris's longitude.
    expect(listing('iwana-rated-5.xhr.txt').rating).toBe(5);
    expect(listing('planity-and-glaura.xhr.txt').rating).toBe(4.5);
  });

  it('reads the French phone from the payload', () => {
    expect(listing('planity-and-glaura.xhr.txt').phoneE164).toBe('+33185736196');
  });
});

describe('what a salon website says', () => {
  async function site(html: string): Promise<{ url: string; close: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('finds its Instagram, its booking platform and "sur rendez-vous"', async () => {
    const page = await site(
      `<p>Salon ouvert uniquement sur rendez-vous.</p>
       <a href="https://www.planity.com/mon-salon-75011-paris">Réserver</a>
       <a href="https://www.instagram.com/monsalon.paris/">Instagram</a>
       <a href="https://www.instagram.com/p/xyz/">un post</a>
       <a href="mailto:contact@monsalon.fr">contact</a>`,
    );
    try {
      const result = await crawlDomain({
        domain: '127.0.0.1',
        startUrl: page.url,
        maxDepth: 0,
        maxPages: 1,
        maxTimeMs: 10_000,
        respectRobots: false,
        perRequestDelayMs: [0, 0],
      });
      expect(result.signals).toEqual({
        instagramUrl: 'https://www.instagram.com/monsalon.paris/',
        bookingProvider: 'Planity',
        bookingUrl: 'https://www.planity.com/mon-salon-75011-paris',
        byAppointment: true,
      });
    } finally {
      await page.close();
    }
  });
});
