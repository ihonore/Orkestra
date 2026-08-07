import { describe, expect, it } from 'vitest';
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
