import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { EmailsRepository } from '../src/db/repositories/emails.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { crawlDomain } from '../src/enrichment/website-emails/crawler.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);
import {
  decodeCfEmail,
  extractEmails,
  fromCloudflare,
  fromJsonLd,
  fromMailto,
  fromObfuscated,
  toSearchableText,
} from '../src/enrichment/website-emails/extract/index.js';
import {
  cleanAddress,
  confidenceFor,
  belongsElsewhere,
  validateEmail,
} from '../src/enrichment/website-emails/validate/rules.js';
import {
  LinkFrontier,
  canonicalize,
  extractLinks,
  scoreLink,
} from '../src/enrichment/website-emails/frontier.js';
import { toggleWww } from '../src/enrichment/website-emails/crawler.js';
import { parseRobots } from '../src/core/http/fetcher.js';

describe('government and institutional exclusion', () => {
  it('rejects federal and military domains', () => {
    for (const address of ['clerk@birminghamal.gov', 'info@sba.ga.gov', 'contact@army.mil']) {
      const verdict = validateEmail(address);
      expect(verdict.isJunk).toBe(true);
      expect(verdict.junkReason).toBe('government');
    }
  });

  it('rejects state, county and school-district domains', () => {
    for (const address of [
      'info@dot.state.al.us',
      'clerk@ci.birmingham.al.us',
      'admin@jefferson.k12.al.us',
    ]) {
      expect(validateEmail(address).junkReason).toBe('government');
    }
  });

  it('rejects universities, which dominated the legacy junk', () => {
    // 146 of 597 addresses in the legacy output came from four universities:
    // cau.edu (67), gsu.edu (41), ua.edu (20), gatech.edu (18).
    for (const address of ['privacy@gatech.edu', 'info@cau.edu', 'x@ox.ac.uk']) {
      expect(validateEmail(address).junkReason).toBe('education');
    }
  });

  it('can be switched off for someone who does sell to institutions', () => {
    expect(validateEmail('x@gatech.edu', { excludeEducation: false }).isJunk).toBe(false);
    expect(validateEmail('x@city.gov', { excludeGovernment: false }).isJunk).toBe(false);
  });

  it('does not reject an ordinary business that merely contains "gov"', () => {
    expect(validateEmail('info@governmentcontractsllc.com').isJunk).toBe(false);
    expect(validateEmail('info@edupro.com').isJunk).toBe(false);
  });
});

describe('junk rules, each from a real legacy row', () => {
  it('rejects the Sentry DSN that was stored as a contact', () => {
    expect(
      validateEmail('605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com').junkReason,
    ).toBe('vendor_telemetry');
  });

  it('rejects image filenames that match a naive email pattern', () => {
    expect(validateEmail('insurance_logos@2x.jpg').junkReason).toBe('asset_extension');
  });

  it('rejects template placeholder domains', () => {
    expect(validateEmail('user@domain.com').junkReason).toBe('placeholder');
    expect(validateEmail('friend@example.com').junkReason).toBe('placeholder');
  });

  it('rejects a hex-run local part, which is a public key not a mailbox', () => {
    expect(validateEmail('a1b2c3d4e5f60718293a@acme.com').junkReason).toBe('hash_local_part');
  });

  it('rejects asset names as the local part', () => {
    expect(validateEmail('logo@acme.com').junkReason).toBe('filename_local_part');
    expect(validateEmail('logo@2x@acme.com').isJunk).toBe(true);
  });

  it('keeps initials, which are not filenames', () => {
    // `BG@rushtonstakely.com` is a law firm partner, not a background image.
    // Losing a real lead costs more than admitting one junk row.
    expect(validateEmail('BG@rushtonstakely.com').isJunk).toBe(false);
    expect(validateEmail('jh@wipfli.com').isJunk).toBe(false);
  });

  it('strips the HTML-escape leak the legacy extractor produced', () => {
    // `u003Eprivacy@gatech.edu` came from regexing raw innerHTML.
    expect(cleanAddress('u003Econtact@acme.com')).toBe('contact@acme.com');
    expect(cleanAddress('<info@acme.com>')).toBe('info@acme.com');
    expect(cleanAddress('mailto:Info@Acme.com')).toBe('info@acme.com');
  });

  it('flags role and free addresses without rejecting them', () => {
    expect(validateEmail('info@acme.com')).toMatchObject({ isJunk: false, isRole: true });
    expect(validateEmail('bob@gmail.com')).toMatchObject({ isJunk: false, isFree: true });
  });
});

describe('confidence', () => {
  it('ranks same-domain highest and third-party lowest', () => {
    expect(confidenceFor(validateEmail('a@acme.com'), 'acme.com')).toBe(1);
    expect(confidenceFor(validateEmail('a@mail.acme.com'), 'acme.com')).toBe(0.9);
    expect(confidenceFor(validateEmail('a@gmail.com'), 'acme.com')).toBe(0.7);
    // Usually a web designer or supplier listed in the footer.
    expect(confidenceFor(validateEmail('a@other.com'), 'acme.com')).toBe(0.4);
  });
});

describe('extraction preprocessing', () => {
  it('removes scripts and attribute values before any matching', () => {
    // This single step is what eliminates telemetry DSNs and image filenames at
    // source, rather than filtering them out afterwards.
    const html = `<script>Sentry.init({dsn:"https://abc@sentry.io/1"})</script>
      <img src="logo@2x.jpg"><p>Write to bob@acme.com</p>`;
    const text = toSearchableText(html);

    expect(text).not.toContain('sentry.io');
    expect(text).not.toContain('logo@2x.jpg');
    expect(text).toContain('bob@acme.com');
  });

  it('decodes HTML entities so an obfuscated address survives', () => {
    expect(toSearchableText('<p>bob&#64;acme.com</p>')).toContain('bob@acme.com');
  });
});

describe('extraction channels', () => {
  it('reads mailto hrefs and strips the query', () => {
    expect(fromMailto('<a href="mailto:bob@acme.com?subject=Hi">x</a>')[0]?.raw).toBe(
      'bob@acme.com',
    );
  });

  it('reads JSON-LD, which is what the business chose to publish', () => {
    const html = `<script type="application/ld+json">
      {"@type":"LocalBusiness","name":"Acme","email":"owner@acme.com"}</script>`;
    expect(fromJsonLd(html)[0]?.raw).toBe('owner@acme.com');
  });

  it('survives malformed JSON-LD, which is extremely common', () => {
    expect(() =>
      fromJsonLd('<script type="application/ld+json">{not json}</script>'),
    ).not.toThrow();
  });

  it('decodes Cloudflare-protected addresses', () => {
    // Without this, every Cloudflare-protected site yields nothing — and 14 of
    // the 74 addresses found on a live run came through this channel.
    const encode = (email: string, key: number): string =>
      key.toString(16).padStart(2, '0') +
      [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

    for (const [email, key] of [
      ['owner@acme.com', 0x76],
      ['bob.smith@plumbing.co.uk', 0x1f],
    ] as const) {
      expect(decodeCfEmail(encode(email, key))).toBe(email);
    }
    expect(fromCloudflare(`<a data-cfemail="${encode('hi@acme.com', 0x2a)}">x</a>`)).toHaveLength(
      1,
    );
  });

  it('rejects malformed cfemail payloads', () => {
    for (const bad of ['zzzz', '7', '', 'abc']) expect(decodeCfEmail(bad)).toBeNull();
  });

  it('reads addresses written to defeat scrapers', () => {
    expect(fromObfuscated('bob (at) acme (dot) com')[0]?.raw).toBe('bob@acme.com');
    expect(fromObfuscated('sales [at] acme.com')[0]?.raw).toBe('sales@acme.com');
  });

  it('attributes an address to its strongest channel', () => {
    // Present as both a mailto and body text; the mailto must win.
    const html = '<a href="mailto:bob@acme.com">x</a><p>bob@acme.com</p>';
    const found = extractEmails(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.method).toBe('mailto');
  });
});

describe('link frontier', () => {
  it('always fetches the entry point first', () => {
    // A guessed /contact scoring above the landing page meant the first request
    // was a URL that often did not exist, and a 404 there condemned the domain.
    expect(scoreLink('https://acme.com', { depth: 0 })).toBeGreaterThan(
      scoreLink('https://acme.com/contact', { depth: 1, inNavOrFooter: true }),
    );
  });

  it('ranks contact pages above everything else at the same depth', () => {
    const contact = scoreLink('https://acme.com/contact-us', { depth: 1 });
    expect(contact).toBeGreaterThan(scoreLink('https://acme.com/blog/post-1', { depth: 1 }));
    expect(contact).toBeGreaterThan(scoreLink('https://acme.com/products/x', { depth: 1 }));
  });

  it('penalises pagination, which is unbounded and near-duplicate', () => {
    expect(scoreLink('https://acme.com/blog?page=7', { depth: 1 })).toBeLessThan(
      scoreLink('https://acme.com/blog', { depth: 1 }),
    );
  });

  it('scores anchor text, so a "Contact us" link to /c/ is still found', () => {
    expect(
      scoreLink('https://acme.com/c/', { depth: 1, anchorText: 'Contact us' }),
    ).toBeGreaterThan(scoreLink('https://acme.com/c/', { depth: 1, anchorText: 'Read more' }));
  });

  it('takes the highest-scoring link first', () => {
    const frontier = new LinkFrontier({ maxDepth: 2, siteDomain: 'acme.com' });
    frontier.offer('https://acme.com/blog/a', { depth: 1 });
    frontier.offer('https://acme.com/contact', { depth: 1 });
    frontier.offer('https://acme.com/products/b', { depth: 1 });

    expect(frontier.take()?.url).toContain('/contact');
  });

  it('stays on the site', () => {
    const frontier = new LinkFrontier({ maxDepth: 2, siteDomain: 'acme.com' });
    expect(frontier.offer('https://evil.com/contact', { depth: 1 })).toBe(false);
    expect(frontier.offer('https://acme.com/contact', { depth: 1 })).toBe(true);
  });

  it('respects the depth limit', () => {
    const frontier = new LinkFrontier({ maxDepth: 1, siteDomain: 'acme.com' });
    expect(frontier.offer('https://acme.com/a', { depth: 2 })).toBe(false);
  });

  it('never queues the same page twice under different tracking parameters', () => {
    // A five-page budget spent three times on /contact would be a real loss.
    const frontier = new LinkFrontier({ maxDepth: 2, siteDomain: 'acme.com' });
    expect(frontier.offer('https://acme.com/contact', { depth: 1 })).toBe(true);
    expect(frontier.offer('https://acme.com/contact/', { depth: 1 })).toBe(false);
    expect(frontier.offer('https://acme.com/contact?utm_source=x', { depth: 1 })).toBe(false);
  });

  it('skips assets and machine endpoints', () => {
    const frontier = new LinkFrontier({ maxDepth: 2, siteDomain: 'acme.com' });
    for (const url of [
      'https://acme.com/logo.png',
      'https://acme.com/app.js',
      'https://acme.com/wp-json/v2',
    ]) {
      expect(frontier.offer(url, { depth: 1 })).toBe(false);
    }
  });

  it('canonicalizes away fragments and tracking parameters', () => {
    expect(canonicalize('https://Acme.com/contact/#top?')).toBe('https://acme.com/contact');
    expect(canonicalize('https://acme.com/a?utm_source=x&id=7')).toBe('https://acme.com/a?id=7');
  });

  it('extracts links with anchor text and nav position', () => {
    const links = extractLinks(
      '<nav><a href="/contact">Contact us</a></nav><a href="/blog">Blog</a>',
      'https://acme.com',
    );
    expect(links[0]).toMatchObject({ anchorText: 'Contact us', inNavOrFooter: true });
    expect(links[1]).toMatchObject({ anchorText: 'Blog', inNavOrFooter: false });
  });
});

describe('www fallback', () => {
  it('toggles between apex and www', () => {
    // Google's URL is not always the working one: 12 of 40 live domains 404'd
    // on the apex while www served fine.
    expect(toggleWww('https://acme.com/x')).toBe('https://www.acme.com/x');
    expect(toggleWww('https://www.acme.com/x')).toBe('https://acme.com/x');
  });

  it('leaves a real subdomain alone', () => {
    expect(toggleWww('https://shop.acme.com')).toBeNull();
  });
});

describe('robots.txt', () => {
  it('lets a longer Allow override a broader Disallow', () => {
    // Otherwise `Disallow: /` plus `Allow: /contact` would block the one page
    // worth fetching.
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /contact');
    expect(rules.allowed('/contact')).toBe(true);
    expect(rules.allowed('/blog')).toBe(false);
  });

  it('reads crawl-delay and sitemaps', () => {
    const rules = parseRobots(
      'User-agent: *\nCrawl-delay: 3\nSitemap: https://acme.com/sitemap.xml',
    );
    expect(rules.crawlDelaySeconds).toBe(3);
    expect(rules.sitemaps).toEqual(['https://acme.com/sitemap.xml']);
  });

  it('allows everything when robots.txt is empty', () => {
    expect(parseRobots('').allowed('/anything')).toBe(true);
  });

  it('ignores rules aimed at a different agent', () => {
    const rules = parseRobots('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /');
    expect(rules.allowed('/contact')).toBe(true);
  });
});

describe('the domain crawl queue', () => {
  function queue(domains: string[]): { repo: EmailsRepository; driver: SqliteDriver } {
    const driver = openDatabase({ file: path.join(tempDir(), 'domains.sqlite') });
    migrate(driver);
    for (const domain of domains) {
      driver
        .prepare(`INSERT INTO domains (domain, is_social, status, created_at) VALUES (?, 0, ?, 0)`)
        .run([domain, 'pending']);
    }
    return { repo: new EmailsRepository(driver), driver };
  }

  const statusOf = (driver: SqliteDriver, domain: string): string =>
    driver.prepare<{ status: string }>(`SELECT status FROM domains WHERE domain = ?`).get([domain])
      ?.status ?? '';

  it('hands an unfinished domain back rather than stranding it', () => {
    // Ctrl-C mid-crawl used to leave the row 'crawling' forever: the claim only
    // ever selects 'pending', so that site was never enriched again.
    const { repo, driver } = queue(['acme.com']);
    const claimed = repo.claimDomain();
    expect(claimed?.domain).toBe('acme.com');
    expect(statusOf(driver, 'acme.com')).toBe('crawling');

    repo.releaseDomain(claimed!.id, claimed!.crawl_epoch);

    expect(statusOf(driver, 'acme.com')).toBe('pending');
    expect(repo.claimDomain()?.domain).toBe('acme.com');
  });

  it('never resurrects a domain that actually finished', () => {
    const { repo, driver } = queue(['acme.com']);
    const claimed = repo.claimDomain()!;
    repo.finishDomain(claimed.id, claimed.crawl_epoch, {
      status: 'done',
      httpStatus: 200,
      finalUrl: 'https://acme.com/',
      isParked: false,
      isDirectoryLike: false,
      pagesFetched: 3,
      bytesFetched: 1000,
      emailsFound: 2,
      error: null,
      nextEligibleAt: Date.now() + 1000,
    });

    repo.releaseDomain(claimed.id, claimed.crawl_epoch);
    expect(statusOf(driver, 'acme.com')).toBe('done');
  });

  it('reclaims domains abandoned by a process that died', () => {
    // The job queue has a reaper for exactly this; the domain queue had none.
    const { repo, driver } = queue(['acme.com', 'beta.com']);
    const stale = repo.claimDomain()!;
    driver
      .prepare(`UPDATE domains SET last_crawled_at = ? WHERE id = ?`)
      .run([Date.now() - 3_600_000, stale.id]);

    expect(repo.reclaimStalledDomains(600_000)).toBe(1);
    expect(statusOf(driver, 'acme.com')).toBe('pending');
  });

  it('fences a reclaimed domain, so the old owner cannot write over the new one', () => {
    // The hazard the reaper creates: the worker it declared dead may be alive.
    // Guarding on status='crawling' is not enough — the new owner has put the
    // row back into exactly that state.
    const { repo, driver } = queue(['acme.com']);
    const stale = repo.claimDomain()!;
    driver
      .prepare(`UPDATE domains SET last_crawled_at = ? WHERE id = ?`)
      .run([Date.now() - 3_600_000, stale.id]);
    repo.reclaimStalledDomains(600_000);
    const fresh = repo.claimDomain()!;

    expect(fresh.crawl_epoch).toBeGreaterThan(stale.crawl_epoch);
    expect(repo.releaseDomain(stale.id, stale.crawl_epoch)).toBe(false);
    expect(
      repo.finishDomain(stale.id, stale.crawl_epoch, {
        status: 'done',
        httpStatus: 200,
        finalUrl: null,
        isParked: false,
        isDirectoryLike: false,
        pagesFetched: 1,
        bytesFetched: 1,
        emailsFound: 99,
        error: null,
        nextEligibleAt: null,
      }),
    ).toBe(false);

    // The new owner still holds it, and none of the stale results landed.
    expect(statusOf(driver, 'acme.com')).toBe('crawling');
    expect(
      driver
        .prepare<{ n: number }>(`SELECT emails_found AS n FROM domains WHERE id = ?`)
        .get([fresh.id])?.n,
    ).toBe(0);
  });

  it('leaves a worker that is merely slow alone', () => {
    const { repo, driver } = queue(['acme.com']);
    const claimed = repo.claimDomain()!;

    expect(repo.reclaimStalledDomains(600_000)).toBe(0);
    expect(statusOf(driver, 'acme.com')).toBe('crawling');
    expect(claimed.domain).toBe('acme.com');
  });
});

describe('rejected addresses are recorded, not silently dropped', () => {
  /** A one-page site serving one usable address and two the rules reject. */
  async function site(html: string): Promise<{ url: string; close: () => Promise<void> }> {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('keeps what a rule threw away, with the reason', async () => {
    // A validation rule that is too aggressive is invisible if its verdicts are
    // discarded — and one already cost this project a real law firm's address,
    // read as an image filename. The rejects are stored so the rule can be
    // reviewed; they are never linked to a business and never exported.
    const page = await site(
      `<a href="mailto:owner@acme.com">write</a>
       <img src="logo@2x.png"> banner@3x.jpg
       <span>3f9a1c2b4d5e6f70@sentry.io</span>`,
    );
    try {
      const result = await crawlDomain({
        domain: '127.0.0.1',
        startUrl: page.url,
        maxDepth: 0,
        maxPages: 1,
        maxTimeMs: 10_000,
        maxBytes: 1_000_000,
        maxEmailsPerPage: 5,
        maxEmailsPerDomain: 25,
        respectRobots: false,
        perRequestDelayMs: [0, 0],
      });

      expect(result.emails.map((e) => e.verdict.address)).toEqual(['owner@acme.com']);
      expect(result.rejected.length).toBeGreaterThan(0);
      for (const rejected of result.rejected) {
        expect(rejected.verdict.isJunk).toBe(true);
        expect(rejected.verdict.junkReason).not.toBeNull();
        // The crawler canonicalises URLs, so the trailing slash is normalised away.
        expect(rejected.sourceUrl).toBe(page.url.replace(/\/$/, ''));
      }
    } finally {
      await page.close();
    }
  });

  it('does not let rejects eat the per-domain budget', async () => {
    // Junk is bounded by the same ceiling as real addresses, so a staff
    // directory cannot fill the table — but it must not crowd out real finds.
    const junk = Array.from({ length: 40 }, (_, i) => `icon${i}@2x.png`).join(' ');
    const page = await site(`<a href="mailto:owner@acme.com">write</a> ${junk}`);
    try {
      const result = await crawlDomain({
        domain: '127.0.0.1',
        startUrl: page.url,
        maxDepth: 0,
        maxPages: 1,
        maxTimeMs: 10_000,
        maxBytes: 1_000_000,
        maxEmailsPerPage: 5,
        maxEmailsPerDomain: 25,
        respectRobots: false,
        perRequestDelayMs: [0, 0],
      });

      expect(result.emails.map((e) => e.verdict.address)).toEqual(['owner@acme.com']);
      expect(result.rejected.length).toBeLessThanOrEqual(25);
    } finally {
      await page.close();
    }
  });
});

describe('re-classifying an address', () => {
  function repo(): { repo: EmailsRepository; driver: SqliteDriver } {
    const driver = openDatabase({ file: path.join(tempDir(), 'reclass.sqlite') });
    migrate(driver);
    return { repo: new EmailsRepository(driver), driver };
  }

  const row = (driver: SqliteDriver, address: string) =>
    driver
      .prepare<{ is_junk: number; is_role: number; is_free: number; junk_reason: string | null }>(
        `SELECT is_junk, is_role, is_free, junk_reason FROM emails WHERE address = ?`,
      )
      .get([address]);

  it('repairs the flags when a rejected address is later accepted', () => {
    // A junk verdict carries placeholder flags — the rules stop at the first
    // reason to reject, so is_role/is_free were never worked out. Storing
    // rejects made that the *first* row for an address, and the conflict clause
    // never refreshed those columns: re-running with looser rules produced a
    // usable address permanently mislabelled as neither role nor free.
    const { repo: emails, driver } = repo();
    emails.upsertEmail({
      address: 'info@acme.com',
      localPart: 'info',
      domain: 'acme.com',
      isRole: false,
      isFree: false,
      isJunk: true,
      junkReason: 'blocked_domain',
    });

    emails.upsertEmail({
      address: 'info@acme.com',
      localPart: 'info',
      domain: 'acme.com',
      isRole: true,
      isFree: false,
      isJunk: false,
      junkReason: null,
    });

    expect(row(driver, 'info@acme.com')).toEqual({
      is_junk: 0,
      is_role: 1,
      is_free: 0,
      junk_reason: null,
    });
  });

  it('does not let a junk verdict blank the flags on a good address', () => {
    // The reverse direction must not repair anything: a junk verdict has no
    // opinion about is_role/is_free, so it must leave them alone.
    const { repo: emails, driver } = repo();
    emails.upsertEmail({
      address: 'sales@acme.com',
      localPart: 'sales',
      domain: 'acme.com',
      isRole: true,
      isFree: true,
      isJunk: false,
      junkReason: null,
    });

    emails.upsertEmail({
      address: 'sales@acme.com',
      localPart: 'sales',
      domain: 'acme.com',
      isRole: false,
      isFree: false,
      isJunk: true,
      junkReason: 'blocked_domain',
    });

    expect(row(driver, 'sales@acme.com')).toEqual({
      is_junk: 1,
      is_role: 1,
      is_free: 1,
      junk_reason: 'blocked_domain',
    });
  });
});

describe('template placeholders and invented endings', () => {
  // Both seen in the sheet the team reads: info@youwebsite.com and
  // support@yourdomain.tld, each looking like a real lead.
  it.each([
    'info@youwebsite.com',
    'info@yourwebsite.com',
    'hello@yourbusiness.com',
    'contact@yourcompanyname.com',
    'me@mydomain.net',
    'support@yourdomain.tld',
    'admin@server.local',
    'example@mail.com',
    'firstname.lastname@tkelevator.com',
    'mymail@mailservice.com',
    'email@address.com',
  ])('rejects %s', (address) => {
    expect(validateEmail(address).isJunk).toBe(true);
  });

  it.each([
    'dr@yourcatvet.com',
    'info@yourgreenpal.com',
    'team@yourbusinesslifestyle.com',
    'office@acme.agency',
    'counsel@smith.lawyer',
    'owner@acme.co.uk',
    'email@rockyheights.com',
  ])('keeps the real address %s', (address) => {
    expect(validateEmail(address).isJunk).toBe(false);
  });
});

describe("addresses on a business's site that belong to someone else", () => {
  const judge = (address: string, site: string | null, name: string) => {
    const v = validateEmail(address);
    return belongsElsewhere(v, site, name);
  };

  // All from the real data.
  it.each([
    ['support@overfuel.com', 'akunitedauto.com', 'United Auto Sales'],
    ['contact@bizsite.link', 'lomyu.me', 'Street Custom - T N T Body Shop'],
    ['bugreport@moatable.com', 'birchequity.co', 'Birch Equity'],
    ['rglegalinquiries@realgeeks.com', 'beautifulalaska.com', 'Beautiful Alaska Realty'],
    ['compliance@curaytor.com', 'bhamrealtyco.com', 'Bham Realty'],
    ['privacy@nva.com', 'alaskaveterinaryclinic.com', 'Alaska Veterinary Clinic'],
  ])('flags %s on %s', (address, site, name) => {
    expect(judge(address, site, name)).toBe(true);
  });

  it.each([
    // The business's own second domain, in its various disguises.
    ['info@rmgaragedoors.com', 'redmountaingaragedoors.com', 'Red Mountain Garage Door'],
    ['info@dewaragency.com', 'dewarinsuranceagency.com', 'Dewar Insurance Agency'],
    ['office@chugachseweranddrain.net', 'chugachsewerdrain.com', 'Chugach Sewer & Drain'],
    ['info@sosalaska.com', 'sosrestorationak.com', 'SOS Restoration LLC'],
    ['info@akmboa.com', 'mortgagebrokersofalaska.com', 'Mortgage Brokers of Alaska, LLC'],
    ['info@ntreak.com', 'northerntrustrealestate.com', 'Northern Trust Real Estate'],
    // A real person at the parent group, not a mailbox.
    ['jeffswickard@swickard.com', 'swickardanchorage.com', 'Swickard Anchorage'],
    ['kwalton@lithia.com', 'anchoragechevrolet.com', 'Chevrolet of South Anchorage'],
    // The business's own domain, and free mail.
    ['privacy@classiccollision.com', 'classiccollision.com', 'Classic Collision'],
    ['info@gmail.com', 'acme.com', 'Acme'],
  ])('keeps %s on %s', (address, site, name) => {
    expect(judge(address, site, name)).toBe(false);
  });
});
