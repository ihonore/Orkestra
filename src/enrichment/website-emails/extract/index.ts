/**
 * Email extraction from a page.
 *
 * Five channels, cheapest and most reliable first. The ordering matters: a
 * `mailto:` href is unambiguous, while a regex over body text is a last resort
 * that needs heavy filtering afterwards.
 *
 * ## The preprocessing that does most of the work
 *
 * The legacy crawler regexed raw `innerHTML`. That is why its output contained
 * Sentry DSNs, `insurance_logos@2x.jpg`, and `u003Eprivacy@gatech.edu` — script
 * bodies, attribute values and JSON blobs all look like text to a regex.
 *
 * Here, `<script>`, `<style>` and `<noscript>` are removed and `src`/`href`/
 * `srcset` attribute values are stripped *before* any text matching. That single
 * step eliminates the majority of the junk at source rather than filtering it
 * out afterwards.
 */

export type ExtractionMethod = 'mailto' | 'jsonld' | 'cfemail' | 'obfuscated' | 'text';

export interface FoundEmail {
  /** As found, before validation. */
  readonly raw: string;
  readonly method: ExtractionMethod;
}

/**
 * A permissive address pattern, used only to *find* candidates.
 *
 * Validation is a separate, much stricter step. Being permissive here and strict
 * later is deliberate: it keeps discovery and policy independent, so a rule
 * change does not require re-crawling.
 */
const CANDIDATE_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi;

/**
 * Remove everything that is not human-visible text.
 *
 * Scripts and styles carry telemetry DSNs; `src`/`href` values carry filenames
 * that match an email pattern. Both are removed rather than filtered later.
 */
export function toSearchableText(html: string): string {
  return (
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      // Attribute values that hold paths, not prose.
      .replace(/\s(?:src|srcset|href|data-src|content|action)\s*=\s*"[^"]*"/gi, ' ')
      .replace(/\s(?:src|srcset|href|data-src|content|action)\s*=\s*'[^']*'/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/\s+/g, ' ')
  );
}

/** `mailto:` hrefs. Unambiguous and highest confidence. */
export function fromMailto(html: string): FoundEmail[] {
  const found: FoundEmail[] = [];
  const pattern = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const value = match[1];
    if (value === undefined) continue;
    // Strip ?subject=/&cc= and percent-decode.
    let address = value.split('?')[0] ?? '';
    try {
      address = decodeURIComponent(address);
    } catch {
      // Leave as-is on a malformed escape.
    }
    if (address.includes('@')) found.push({ raw: address, method: 'mailto' });
  }
  return found;
}

/**
 * JSON-LD and microdata `email` properties.
 *
 * Structured data a site publishes about itself is high quality by definition —
 * it is the address the business chose to advertise.
 */
export function fromJsonLd(html: string): FoundEmail[] {
  const found: FoundEmail[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    const body = block[1];
    if (body === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // Malformed JSON-LD is extremely common; skip quietly.
    }
    collectEmailProperties(parsed, found, 0);
  }

  // Microdata: <span itemprop="email">x@y.com</span>
  for (const match of html.matchAll(/itemprop\s*=\s*["']email["'][^>]*>([^<]+)</gi)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.includes('@')) {
      found.push({ raw: value, method: 'jsonld' });
    }
  }

  return found;
}

function collectEmailProperties(node: unknown, out: FoundEmail[], depth: number): void {
  if (depth > 8 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node as unknown[]) collectEmailProperties(child, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase() === 'email' && typeof value === 'string' && value.includes('@')) {
      out.push({ raw: value, method: 'jsonld' });
    } else {
      collectEmailProperties(value, out, depth + 1);
    }
  }
}

/**
 * Decode Cloudflare's email obfuscation.
 *
 * Cloudflare replaces addresses with `<a class="__cf_email__"
 * data-cfemail="a1c4ccc0c8...">`. The payload is hex; the first byte is an XOR
 * key applied to every subsequent byte. Without this, any site behind
 * Cloudflare's email protection yields nothing — and that is a large share of
 * small-business sites.
 */
export function decodeCfEmail(encoded: string): string | null {
  if (!/^[0-9a-f]+$/i.test(encoded) || encoded.length < 4 || encoded.length % 2 !== 0) return null;

  const key = Number.parseInt(encoded.slice(0, 2), 16);
  if (!Number.isFinite(key)) return null;

  let decoded = '';
  for (let i = 2; i < encoded.length; i += 2) {
    const byte = Number.parseInt(encoded.slice(i, i + 2), 16);
    if (!Number.isFinite(byte)) return null;
    decoded += String.fromCharCode(byte ^ key);
  }
  return decoded.includes('@') ? decoded : null;
}

export function fromCloudflare(html: string): FoundEmail[] {
  const found: FoundEmail[] = [];
  for (const match of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
    const decoded = match[1] !== undefined ? decodeCfEmail(match[1]) : null;
    if (decoded !== null) found.push({ raw: decoded, method: 'cfemail' });
  }
  // The link form of the same protection: href="/cdn-cgi/l/email-protection#…".
  for (const match of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    const decoded = match[1] !== undefined ? decodeCfEmail(match[1]) : null;
    if (decoded !== null) found.push({ raw: decoded, method: 'cfemail' });
  }
  return found;
}

/**
 * Addresses written to defeat scrapers: `name (at) domain (dot) com`.
 *
 * Worth handling because a business that obfuscates its address is usually a
 * real business protecting a real inbox, not a directory.
 */
export function fromObfuscated(text: string): FoundEmail[] {
  const found: FoundEmail[] = [];
  const pattern =
    /([a-z0-9._%+-]+)\s*(?:\(at\)|\[at\]|\{at\}|\sat\s|&#64;|\(@\)|\(arobase\)|\[arobase\]|\sarobase\s)\s*([a-z0-9.-]+)\s*(?:\(dot\)|\[dot\]|\{dot\}|\sdot\s|\(point\)|\[point\]|\spoint\s)\s*([a-z]{2,63})/gi;

  for (const match of text.matchAll(pattern)) {
    const [, local, domain, tld] = match;
    if (local !== undefined && domain !== undefined && tld !== undefined) {
      found.push({ raw: `${local}@${domain}.${tld}`, method: 'obfuscated' });
    }
  }

  // The simpler `name (at) domain.com` form, where the TLD is not split.
  const simple =
    /([a-z0-9._%+-]+)\s*(?:\(at\)|\[at\]|\{at\}|\(arobase\)|\[arobase\])\s*([a-z0-9.-]+\.[a-z]{2,63})/gi;
  for (const match of text.matchAll(simple)) {
    const [, local, domain] = match;
    if (local !== undefined && domain !== undefined) {
      found.push({ raw: `${local}@${domain}`, method: 'obfuscated' });
    }
  }

  return found;
}

/** Plain addresses in visible text. The last resort. */
export function fromText(text: string): FoundEmail[] {
  return [...text.matchAll(CANDIDATE_RE)].map((m) => ({ raw: m[0], method: 'text' as const }));
}

/**
 * Run every channel over one page.
 *
 * Results keep their first-seen method, and channels are applied in confidence
 * order, so an address found in both a `mailto:` and body text is attributed to
 * the `mailto:`.
 */
export function extractEmails(html: string): FoundEmail[] {
  const text = toSearchableText(html);

  const ordered: FoundEmail[] = [
    ...fromMailto(html),
    ...fromJsonLd(html),
    ...fromCloudflare(html),
    ...fromObfuscated(text),
    ...fromText(text),
  ];

  const seen = new Map<string, FoundEmail>();
  for (const item of ordered) {
    const key = item.raw.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
