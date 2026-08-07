/**
 * Proxy list parsing.
 *
 * Providers hand out credentials in several shapes and none of them agree, so
 * this accepts the common ones and normalizes to {@link ProxySettings}. The one
 * rule that never bends: credentials come out in separate fields and never stay
 * embedded in the server URL, because Playwright rebuilds `server` from protocol
 * and host and silently drops userinfo.
 */
import { ConfigError } from '../errors/taxonomy.js';
import type { ProxySettings } from './types.js';

/** Schemes Playwright accepts for the `server` field. */
const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks4:']);

export interface ParsedProxyLine {
  readonly settings: ProxySettings;
  /** Human-readable identity for logs: host:port, never the password. */
  readonly label: string;
}

/**
 * Parse one proxy line.
 *
 * Accepted forms:
 *   host:port
 *   host:port:username:password
 *   scheme://host:port
 *   scheme://username:password@host:port
 *
 * A bare `host:port:user:pass` is the format most residential providers hand
 * out, and it is ambiguous with an IPv6 literal, so IPv6 must use URL form.
 */
export function parseProxyLine(line: string, defaultScheme = 'http'): ParsedProxyLine {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    throw new ConfigError(`Not a proxy entry: ${JSON.stringify(line)}`, {
      code: 'CONFIG_INVALID',
    });
  }

  if (trimmed.includes('://')) return parseUrlForm(trimmed);

  const parts = trimmed.split(':');
  // The length checks guarantee these indices exist; `build` already accepts
  // undefined for the credential pair, so only host and port need asserting.
  if (parts.length === 2) {
    return build(defaultScheme, parts[0]!, parts[1]!, undefined, undefined);
  }
  if (parts.length === 4) {
    return build(defaultScheme, parts[0]!, parts[1]!, parts[2], parts[3]);
  }

  throw new ConfigError(`Cannot parse proxy entry: ${JSON.stringify(trimmed)}`, {
    code: 'CONFIG_INVALID',
    hint:
      'Expected host:port, host:port:username:password, or a scheme://... URL.\n' +
      'An IPv6 address must use the URL form, e.g. http://[::1]:8080',
  });
}

function parseUrlForm(input: string): ParsedProxyLine {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConfigError(`Cannot parse proxy URL: ${JSON.stringify(input)}`, {
      code: 'CONFIG_INVALID',
    });
  }

  if (!SUPPORTED_SCHEMES.has(url.protocol)) {
    throw new ConfigError(`Unsupported proxy scheme: ${url.protocol}`, {
      code: 'CONFIG_INVALID',
      hint: `Supported: ${[...SUPPORTED_SCHEMES].join(', ')}`,
    });
  }
  if (url.hostname === '') {
    throw new ConfigError(`Proxy URL has no host: ${JSON.stringify(input)}`, {
      code: 'CONFIG_INVALID',
    });
  }

  // decodeURIComponent because credentials with '@' or ':' must be percent-encoded
  // in URL form to parse at all.
  const username = url.username === '' ? undefined : decodeURIComponent(url.username);
  const password = url.password === '' ? undefined : decodeURIComponent(url.password);

  return build(
    url.protocol.replace(':', ''),
    url.hostname,
    url.port === '' ? defaultPortFor(url.protocol) : url.port,
    username,
    password,
  );
}

function defaultPortFor(protocol: string): string {
  if (protocol === 'https:') return '443';
  if (protocol.startsWith('socks')) return '1080';
  return '80';
}

function build(
  scheme: string,
  host: string,
  port: string,
  username: string | undefined,
  password: string | undefined,
): ParsedProxyLine {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new ConfigError(`Invalid proxy port: ${JSON.stringify(port)}`, {
      code: 'CONFIG_INVALID',
    });
  }

  // Playwright throws on SOCKS with credentials, and the failure appears at
  // context creation — long after the config was written. Catch it here.
  if (scheme.startsWith('socks') && username !== undefined) {
    throw new ConfigError(`SOCKS proxies cannot carry credentials: ${host}:${port}`, {
      code: 'CONFIG_INVALID',
      hint:
        'Playwright rejects authenticated SOCKS. Use an http:// or https:// endpoint, ' +
        'which is also required for username-encoded sticky sessions.',
    });
  }

  // Bracket IPv6 literals so the server URL parses.
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return {
    settings: {
      server: `${scheme}://${hostPart}:${portNumber}`,
      ...(username !== undefined && { username }),
      ...(password !== undefined && { password }),
    },
    label: `${hostPart}:${portNumber}`,
  };
}

/** Parse a proxy list file, skipping blanks and `#` comments. */
export function parseProxyList(contents: string, defaultScheme = 'http'): ParsedProxyLine[] {
  const entries: ParsedProxyLine[] = [];
  const lines = contents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    try {
      entries.push(parseProxyLine(trimmed, defaultScheme));
    } catch (cause) {
      throw new ConfigError(
        `Proxy list line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { code: 'CONFIG_INVALID', cause },
      );
    }
  }

  return entries;
}

/**
 * Build a sticky-session username for a rotating gateway.
 *
 * The token format differs per provider — Bright Data, Oxylabs and Smartproxy
 * all encode the session differently — so the pattern is configuration, not a
 * hardcoded string. `{session}` is substituted; anything else is passed through.
 */
export function stickyUsername(pattern: string, baseUsername: string, session: string): string {
  if (!pattern.includes('{session}')) {
    throw new ConfigError(`Sticky session pattern must contain {session}: ${pattern}`, {
      code: 'CONFIG_INVALID',
      hint: 'For example: "{username}-session-{session}" or "user-{username}-sess-{session}"',
    });
  }
  return pattern.replaceAll('{username}', baseUsername).replaceAll('{session}', session);
}
