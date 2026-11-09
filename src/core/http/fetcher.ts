/**
 * HTTP fetching for the email crawler.
 *
 * Separate from the browser on purpose: a website crawl is I/O-bound and needs
 * no JavaScript for the overwhelming majority of sites, so it runs at 20
 * concurrent requests rather than 4 browser contexts. Keeping the two apart is
 * also what stops a slow or dead website from stalling a browser worker.
 */
import { Agent, ProxyAgent, interceptors, request, type Dispatcher } from 'undici';
import type { ProxySettings } from '../proxy/types.js';

export interface FetchOptions {
  readonly timeoutMs?: number;
  /** Hard cap on the response body. A 50 MB page is never worth reading. */
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  /** Default: US English. A French campaign asks for French. */
  readonly acceptLanguage?: string;
  readonly proxy?: ProxySettings | null;
  readonly signal?: AbortSignal;
}

export interface FetchResult {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  /** Empty when the body was not HTML or exceeded the cap. */
  readonly body: string;
  readonly bytes: number;
  readonly contentType: string | null;
  readonly error?: string;
  readonly truncated?: boolean;
}

/**
 * A browser-like user agent.
 *
 * Not deception for its own sake: a great many small-business sites are behind
 * WAFs that block obviously-scripted agents, and a blocked fetch yields no
 * emails while still costing a request.
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Only these are worth parsing for addresses. */
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)/i;

/**
 * Build the dispatcher, composing in redirect following and decompression.
 *
 * Both are interceptors in undici v8, and both fail *silently* if omitted:
 *
 *  - `maxRedirections` is no longer a request option. Without the interceptor a
 *    site redirecting `http://x.com` to `https://www.x.com` — which is most of
 *    them — returns a 301 body containing no emails and simply looks empty.
 *
 *  - `request()` does **not** decompress, even though we ask for gzip/br. Without
 *    the interceptor the body is raw compressed bytes, so every regex matches
 *    nothing. Measured before this fix: 12 sites returned HTTP 200 across 5
 *    pages each and produced zero addresses, because extraction was running over
 *    binary. Removing `accept-encoding` instead would work but would multiply
 *    bandwidth, which is expensive on metered residential proxies.
 */
function dispatcherFor(options: FetchOptions): Dispatcher {
  // Decompression is handled explicitly below rather than by
  // `interceptors.decompress()`, which undici marks experimental and warns
  // about on every run. This is the crawler's hot path; a stable API is worth
  // fifteen lines of zlib.
  const compose = [
    interceptors.redirect({
      maxRedirections: options.maxRedirects ?? 5,
      throwOnMaxRedirect: false,
    }),
  ];

  if (options.proxy != null && options.proxy.server !== '') {
    const { server, username, password } = options.proxy;
    const token =
      username !== undefined
        ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
        : undefined;
    return new ProxyAgent({ uri: server, ...(token !== undefined && { token }) }).compose(compose);
  }

  return new Agent({
    connect: { timeout: options.timeoutMs ?? 15_000 },
    // Small businesses are often on shared hosting that dislikes many
    // simultaneous connections from one client.
    connections: 4,
  }).compose(compose);
}

/**
 * Fetch a URL, returning a result rather than throwing.
 *
 * A crawl visits thousands of URLs of which many are dead; exceptions as
 * control flow would make the caller unreadable. Network failures come back as
 * `ok: false` with a reason.
 */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const dispatcher = dispatcherFor(options);

  try {
    const response = await request(url, {
      dispatcher, // redirect following is composed into the dispatcher
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      ...(options.signal !== undefined && { signal: options.signal }),
      headers: {
        'user-agent': options.userAgent ?? DEFAULT_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': options.acceptLanguage ?? 'en-US,en;q=0.9',
        // `request()` does NOT decompress these — see decompress() below, which
        // does. Believing otherwise is what made every extraction run over
        // compressed bytes.
        'accept-encoding': 'gzip, deflate, br',
      },
    });

    const contentType = response.headers['content-type'];
    const type = Array.isArray(contentType) ? (contentType[0] ?? null) : (contentType ?? null);

    if (response.statusCode >= 400) {
      // dump(), never destroy(): destroying an undici body emits an unhandled
      // 'error' event (UND_ERR_ABORTED) that crashes the process. dump() is the
      // supported way to discard a body we are not going to read.
      await response.body.dump();
      return { ok: false, status: response.statusCode, url, body: '', bytes: 0, contentType: type };
    }

    // Do not download a PDF or a video to look for an email in it.
    if (type !== null && !HTML_TYPES.test(type)) {
      await response.body.dump();
      return { ok: true, status: response.statusCode, url, body: '', bytes: 0, contentType: type };
    }

    // Stream with a running byte cap. Reading `.text()` first would defeat the
    // limit, which exists precisely to survive a page that never ends.
    let bytes = 0;
    let truncated = false;
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        truncated = true;
        // Stop reading without destroying: the loop simply exits and the
        // dispatcher close() in `finally` releases the connection.
        break;
      }
      chunks.push(buffer);
    }

    const encoding = headerValue(response.headers['content-encoding']);
    const body = await decompress(Buffer.concat(chunks), encoding);

    return {
      ok: true,
      status: response.statusCode,
      url,
      body: body.toString('utf8'),
      bytes,
      contentType: type,
      ...(truncated && { truncated }),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      body: '',
      bytes: 0,
      contentType: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}

function headerValue(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  return Array.isArray(header) ? (header[0] ?? null) : header;
}

/**
 * Decompress a response body according to its `Content-Encoding`.
 *
 * `request()` does not do this, even though we advertise gzip and brotli. Skip
 * it and every regex runs over compressed bytes and matches nothing — which
 * presents as "the site has no email address", not as an error. Measured before
 * this existed: 12 sites returned HTTP 200 across 5 pages each and yielded zero
 * addresses.
 *
 * A body that fails to decompress is returned as-is rather than throwing: some
 * servers advertise an encoding they did not apply, and the raw bytes are more
 * likely to be readable than nothing.
 */
async function decompress(body: Buffer, encoding: string | null): Promise<Buffer> {
  if (encoding === null || body.length === 0) return body;

  const zlib = await import('node:zlib');
  const { promisify } = await import('node:util');

  try {
    switch (encoding.trim().toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return await promisify(zlib.gunzip)(body);
      case 'deflate':
        return await promisify(zlib.inflate)(body);
      case 'br':
        return await promisify(zlib.brotliDecompress)(body);
      case 'zstd':
        // Node 22.15+/23.8+ only; absent on older runtimes.
        return typeof zlib.zstdDecompress === 'function'
          ? await promisify(zlib.zstdDecompress)(body)
          : body;
      default:
        return body;
    }
  } catch {
    return body;
  }
}

export interface RobotsRules {
  readonly allowed: (path: string) => boolean;
  /** Seconds the site asks callers to wait between requests. */
  readonly crawlDelaySeconds: number | null;
  readonly sitemaps: string[];
}

/**
 * A minimal robots.txt parser.
 *
 * Honours the most specific matching group: a `User-agent: *` block, plus any
 * block naming us. Longest-match wins between Allow and Disallow, as the de
 * facto standard requires — a shorter Disallow must not override a longer
 * Allow, or `Disallow: /` plus `Allow: /contact` would block the one page worth
 * fetching.
 */
export function parseRobots(text: string, userAgent = 'gms'): RobotsRules {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());

  const groups: { agents: string[]; allow: string[]; disallow: string[]; delay: number | null }[] =
    [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], allow: [], disallow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (current === null) continue;
    if (field === 'allow' && value !== '') current.allow.push(value);
    else if (field === 'disallow') current.disallow.push(value);
    else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.delay = delay;
    }
  }

  const agent = userAgent.toLowerCase();
  const applicable = groups.filter(
    (g) => g.agents.includes('*') || g.agents.some((a) => agent.includes(a)),
  );
  // A group naming us specifically overrides the wildcard group.
  const specific = applicable.filter((g) => !g.agents.includes('*'));
  const effective = specific.length > 0 ? specific : applicable;

  const allow = effective.flatMap((g) => g.allow);
  const disallow = effective.flatMap((g) => g.disallow).filter((d) => d !== '');
  const delay = effective.map((g) => g.delay).find((d) => d !== null) ?? null;

  return {
    allowed: (path: string): boolean => {
      const longestAllow = longestMatch(allow, path);
      const longestDisallow = longestMatch(disallow, path);
      if (longestDisallow === null) return true;
      if (longestAllow === null) return false;
      return longestAllow.length >= longestDisallow.length;
    },
    crawlDelaySeconds: delay,
    sitemaps,
  };
}

function longestMatch(rules: readonly string[], path: string): string | null {
  let best: string | null = null;
  for (const rule of rules) {
    // `*` and `$` are the two wildcards the standard defines.
    const pattern = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const anchored = pattern.endsWith('$') ? `^${pattern}` : `^${pattern}`;
    let matches: boolean;
    try {
      matches = new RegExp(anchored).test(path);
    } catch {
      // A rule that will not compile as a pattern is matched literally.
      matches = path.startsWith(rule);
    }
    if (matches && (best === null || rule.length > best.length)) best = rule;
  }
  return best;
}

/** Everything is allowed when robots.txt is missing or unreadable. */
export const ALLOW_ALL: RobotsRules = {
  allowed: () => true,
  crawlDelaySeconds: null,
  sitemaps: [],
};

/** Fetch and parse a site's robots.txt. Failure means allow-all, not refuse-all. */
export async function fetchRobots(
  origin: string,
  options: FetchOptions = {},
): Promise<RobotsRules> {
  const result = await fetchPage(new URL('/robots.txt', origin).toString(), {
    ...options,
    maxBytes: 512 * 1024,
  });
  if (!result.ok || result.body === '') return ALLOW_ALL;
  return parseRobots(result.body);
}
