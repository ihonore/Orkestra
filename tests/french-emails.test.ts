/**
 * Finding a French salon's address on its website, and judging it.
 *
 * The word lists are shared by every campaign: a French word added here
 * changes nothing on an American site.
 */
import { describe, expect, it } from 'vitest';
import {
  belongsElsewhere,
  validateEmail,
} from '../src/enrichment/website-emails/validate/rules.js';
import {
  extractEmails,
  fromCloudflare,
  fromObfuscated,
} from '../src/enrichment/website-emails/extract/index.js';
import { LinkFrontier, scoreLink } from '../src/enrichment/website-emails/frontier.js';
import { crawlDomain } from '../src/enrichment/website-emails/crawler.js';
import { domainOf } from '../src/automations/google-maps/normalize.js';
import { loadConfig } from '../src/config/loader.js';
import { campaignDir } from '../src/core/util/paths.js';

describe('French mailboxes', () => {
  it('rejects data-protection and do-not-reply mailboxes', () => {
    for (const address of [
      'rgpd@monsalon.fr',
      'cnil@monsalon.fr',
      'donnees-personnelles@monsalon.fr',
      'protection.donnees@monsalon.fr',
      'nepasrepondre@monsalon.fr',
      'ne-pas-repondre@monsalon.fr',
      'desinscription@monsalon.fr',
    ]) {
      expect(validateEmail(address).junkReason, address).toBe('non_contact');
    }
  });

  it("treats a salon's front desk as a role address, not a person", () => {
    for (const address of ['bonjour@monsalon.fr', 'rdv@monsalon.fr', 'accueil@monsalon.fr']) {
      const verdict = validateEmail(address);
      expect(verdict.isJunk, address).toBe(false);
      expect(verdict.isRole, address).toBe(true);
    }
    expect(validateEmail('aminata@monsalon.fr').isRole).toBe(false);
  });

  it('knows the French ISP mailboxes independents use', () => {
    for (const address of ['salon.nina@orange.fr', 'x@wanadoo.fr', 'x@free.fr', 'x@hotmail.fr']) {
      const verdict = validateEmail(address);
      expect(verdict.isJunk, address).toBe(false);
      expect(verdict.isFree, address).toBe(true);
    }
    // Free mail is never someone else's address, so it is never dropped as
    // off-site — the old treatment of contact@orange.fr.
    expect(belongsElsewhere(validateEmail('contact@orange.fr'), 'monsalon.fr', 'Mon Salon')).toBe(
      false,
    );
  });

  it('rejects the state, town halls and schools', () => {
    expect(validateEmail('accueil@interieur.gouv.fr').junkReason).toBe('government');
    expect(validateEmail('contact@mairie-montreuil.fr').junkReason).toBe('government');
    expect(validateEmail('contact@paris.fr').junkReason).toBe('government');
    expect(validateEmail('ce.0750001@ac-paris.fr').junkReason).toBe('education');
    expect(validateEmail('scol@univ-paris1.fr').junkReason).toBe('education');
  });

  it("rejects hosts, booking platforms and mediators named on a salon's site", () => {
    for (const address of [
      'support@ovh.com',
      'contact@planity.com',
      'pro@treatwell.fr',
      'contact@cm2c.net',
      'contact@mediateur-conso.fr',
    ]) {
      expect(validateEmail(address).junkReason, address).toBe('vendor_telemetry');
    }
    // A US business named for mediation is not a French consumer mediator.
    expect(validateEmail('info@mediationfirm.com').isJunk).toBe(false);
  });
});

describe('finding addresses on French sites', () => {
  it('reads "arobase" and "point"', () => {
    expect(fromObfuscated('contact [arobase] monsalon [point] fr').map((e) => e.raw)).toEqual([
      'contact@monsalon.fr',
    ]);
    expect(fromObfuscated('bonjour (arobase) monsalon.fr').map((e) => e.raw)).toEqual([
      'bonjour@monsalon.fr',
    ]);
  });

  it("decodes Cloudflare's link form of email protection", () => {
    // "a@b.fr", XOR key 0x12.
    const encoded =
      '12' +
      [...'a@b.fr'].map((c) => (c.charCodeAt(0) ^ 0x12).toString(16).padStart(2, '0')).join('');
    const html = `<a href="/cdn-cgi/l/email-protection#${encoded}">[email protected]</a>`;
    expect(fromCloudflare(html).map((e) => e.raw)).toEqual(['a@b.fr']);
    expect(extractEmails(html).map((e) => e.raw)).toContain('a@b.fr');
  });

  it('goes to the mentions légales and contact pages first', () => {
    const blog = scoreLink('https://monsalon.fr/blog/nouveautes');
    for (const page of ['/mentions-legales', '/nous-contacter', '/a-propos', '/qui-sommes-nous']) {
      expect(scoreLink(`https://monsalon.fr${page}`), page).toBeGreaterThan(blog);
      expect(scoreLink(`https://monsalon.fr${page}`), page).toBeGreaterThan(2);
    }
  });

  it('tries the French paths on a French campaign', () => {
    const config = loadConfig({ cwd: campaignDir('gobadiz'), env: {} });
    expect(config.enrichment.websiteEmails.guessPaths).toContain('/mentions-legales');
    const main = loadConfig({ cwd: campaignDir('gobadiz').replace(/campaigns.*$/, ''), env: {} });
    expect(main.enrichment.websiteEmails.guessPaths).toEqual([
      '/contact',
      '/contact-us',
      '/about',
      '/about-us',
    ]);
  });
});

describe('sites on a website builder', () => {
  it('gives each its own domain, not the builder’s', () => {
    expect(domainOf('https://ouassimsorbonne.wixsite.com/barbierdesstars')?.domain).toBe(
      'ouassimsorbonne.wixsite.com',
    );
    expect(domainOf('https://salon-nina.jimdofree.com/')?.domain).toBe('salon-nina.jimdofree.com');
    expect(domainOf('https://www.monsalon.webnode.fr/')?.domain).toBe('monsalon.webnode.fr');
    // An ordinary subdomain still belongs to its registrable domain.
    expect(domainOf('https://paris.monsalon.fr/')?.domain).toBe('monsalon.fr');
  });

  it('crawls a site that starts on a subdomain', () => {
    const frontier = new LinkFrontier({
      maxDepth: 1,
      siteDomain: 'monsalon.fr',
      startHost: 'paris.monsalon.fr',
    });
    expect(frontier.offer('https://paris.monsalon.fr/', { depth: 0 })).toBe(true);
    expect(frontier.offer('https://paris.monsalon.fr/contact', { depth: 1 })).toBe(true);
    expect(frontier.offer('https://autre.fr/contact', { depth: 1 })).toBe(false);
  });
});

describe('a French parked page', () => {
  it('is recognised', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/robots.txt' ? 404 : 200, { 'content-type': 'text/html' });
      res.end('<h1>Site en construction</h1><p>Revenez bientôt</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await crawlDomain({
        domain: '127.0.0.1',
        startUrl: `http://127.0.0.1:${port}/`,
        maxDepth: 0,
        maxPages: 1,
        respectRobots: false,
        perRequestDelayMs: [0, 0],
      });
      expect(result.status).toBe('parked');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
