/**
 * Proxy provider implementations.
 *
 * Three modes, one interface:
 *  - `none`     — direct connection. Explicit, so nobody scrapes from the office
 *                 IP by accident.
 *  - `list`     — a file of proxies, handed out least-recently-used and weighted
 *                 by health, with cooldown for identities that got blocked.
 *  - `gateway`  — one endpoint that rotates for you; identity is expressed as a
 *                 sticky-session token encoded in the username.
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ProxyAgent, request } from 'undici';
import { ConfigError } from '../errors/taxonomy.js';
import { displayPath } from '../util/paths.js';
import { parseProxyList, stickyUsername, type ParsedProxyLine } from './parse.js';
import type {
  ProxyHealth,
  ProxyOutcome,
  ProxyProbe,
  ProxyProvider,
  ProxyPurpose,
  ProxySession,
  ProxySettings,
} from './types.js';

/** Default endpoint for `doctor --proxies`. Returns the caller's IP as plain text. */
const DEFAULT_PROBE_URL = 'https://api.ipify.org?format=json';

export interface ProxyPolicy {
  /** Consecutive failures before an identity is benched. */
  readonly maxConsecutiveFailures: number;
  /** How long a blocked identity stays benched. */
  readonly banCooldownSeconds: number;
}

export const DEFAULT_POLICY: ProxyPolicy = {
  maxConsecutiveFailures: 3,
  banCooldownSeconds: 900,
};

/** Mutable health record for one identity. */
interface Entry {
  readonly id: string;
  readonly label: string;
  readonly settings: ProxySettings;
  inUse: boolean;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  blocks: number;
  cooldownUntil: number | null;
  lastOutcome: ProxyOutcome | null;
  lastUsedAt: number | null;
}

function toHealth(entry: Entry): ProxyHealth {
  return {
    id: entry.id,
    label: entry.label,
    healthy: entry.cooldownUntil === null,
    inUse: entry.inUse,
    successes: entry.successes,
    failures: entry.failures,
    consecutiveFailures: entry.consecutiveFailures,
    blocks: entry.blocks,
    cooldownUntil: entry.cooldownUntil,
    lastOutcome: entry.lastOutcome,
    lastUsedAt: entry.lastUsedAt,
  };
}

/**
 * Probe one proxy by asking an echo service what IP it sees.
 *
 * Shared by every provider so `doctor --proxies` reports the same way for all.
 */
async function probeOne(
  entry: Pick<Entry, 'id' | 'label' | 'settings'>,
  url: string,
  timeoutMs: number,
): Promise<ProxyProbe> {
  const { server, username, password } = entry.settings;
  const started = performance.now();

  // undici wants credentials as a Proxy-Authorization header; it does not read
  // them from the URL either.
  const token =
    username !== undefined
      ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
      : undefined;

  const agent = new ProxyAgent({
    uri: server,
    ...(token !== undefined && { token }),
  });

  try {
    const response = await request(url, {
      dispatcher: agent,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const body = await response.body.text();
    const latencyMs = Math.round(performance.now() - started);

    if (response.statusCode >= 400) {
      return {
        id: entry.id,
        label: entry.label,
        ok: false,
        latencyMs,
        error: `HTTP ${response.statusCode}`,
      };
    }

    let egressIp: string | undefined;
    try {
      const parsed = JSON.parse(body) as { ip?: unknown };
      if (typeof parsed.ip === 'string') egressIp = parsed.ip;
    } catch {
      // Not JSON — many echo endpoints return a bare IP.
      const text = body.trim();
      if (/^[0-9a-f.:]+$/i.test(text) && text.length < 46) egressIp = text;
    }

    return {
      id: entry.id,
      label: entry.label,
      ok: true,
      latencyMs,
      ...(egressIp !== undefined && { egressIp }),
    };
  } catch (error) {
    return {
      id: entry.id,
      label: entry.label,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await agent.close();
  }
}

/** Direct connection. No identity rotation, no health to track. */
export class NoProxyProvider implements ProxyProvider {
  readonly mode = 'none' as const;
  readonly size = null;

  acquire(_purpose: ProxyPurpose, now: number = Date.now()): ProxySession {
    return { id: 'direct', settings: { server: '' }, acquiredAt: now };
  }

  release(): void {
    // Nothing to account for.
  }

  health(): ProxyHealth[] {
    return [];
  }

  probe(): Promise<ProxyProbe[]> {
    return Promise.resolve([]);
  }
}

/**
 * A fixed list of proxies, handed out least-recently-used.
 *
 * LRU rather than random: it spreads load evenly and, more importantly, gives
 * each identity the longest possible rest between uses, which is what keeps
 * per-identity request rates below whatever Google is measuring.
 */
export class StaticListProvider implements ProxyProvider {
  readonly mode = 'list' as const;
  readonly #entries: Entry[];
  readonly #policy: ProxyPolicy;

  constructor(entries: readonly ParsedProxyLine[], policy: ProxyPolicy = DEFAULT_POLICY) {
    if (entries.length === 0) {
      throw new ConfigError('Proxy list is empty.', {
        code: 'CONFIG_INVALID',
        hint: 'Add at least one proxy, or set proxy.mode: none.',
      });
    }
    this.#policy = policy;
    this.#entries = entries.map((entry, index) => ({
      id: `p${index + 1}`,
      label: entry.label,
      settings: entry.settings,
      inUse: false,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      blocks: 0,
      cooldownUntil: null,
      lastOutcome: null,
      lastUsedAt: null,
    }));
  }

  static fromFile(file: string, policy?: ProxyPolicy, defaultScheme = 'http'): StaticListProvider {
    if (!fs.existsSync(file)) {
      throw new ConfigError(`Proxy list not found: ${displayPath(file)}`, {
        code: 'CONFIG_INVALID',
        hint: 'Set proxy.list.file to a file of host:port:username:password lines.',
      });
    }
    return new StaticListProvider(
      parseProxyList(fs.readFileSync(file, 'utf8'), defaultScheme),
      policy,
    );
  }

  get size(): number {
    return this.#entries.length;
  }

  acquire(_purpose: ProxyPurpose, now: number = Date.now()): ProxySession | null {
    // Expire cooldowns first, so a rested identity becomes available again.
    for (const entry of this.#entries) {
      if (entry.cooldownUntil !== null && entry.cooldownUntil <= now) {
        entry.cooldownUntil = null;
        entry.consecutiveFailures = 0;
      }
    }

    const available = this.#entries.filter((e) => !e.inUse && e.cooldownUntil === null);
    if (available.length === 0) return null;

    // Least recently used first; never-used entries sort first.
    available.sort((a, b) => (a.lastUsedAt ?? -1) - (b.lastUsedAt ?? -1));
    const chosen = available[0]!;
    chosen.inUse = true;
    chosen.lastUsedAt = now;

    return { id: chosen.id, settings: chosen.settings, acquiredAt: now };
  }

  release(session: ProxySession, outcome: ProxyOutcome, now: number = Date.now()): void {
    const entry = this.#entries.find((e) => e.id === session.id);
    if (entry === undefined) return;

    entry.inUse = false;
    entry.lastOutcome = outcome;

    if (outcome === 'ok') {
      entry.successes += 1;
      entry.consecutiveFailures = 0;
      return;
    }

    entry.failures += 1;
    entry.consecutiveFailures += 1;

    // A block is a statement about this identity, so bench it immediately
    // rather than waiting for a failure streak.
    if (outcome === 'blocked') {
      entry.blocks += 1;
      entry.cooldownUntil = now + this.#policy.banCooldownSeconds * 1000;
      return;
    }

    if (entry.consecutiveFailures >= this.#policy.maxConsecutiveFailures) {
      entry.cooldownUntil = now + this.#policy.banCooldownSeconds * 1000;
    }
  }

  health(): ProxyHealth[] {
    return this.#entries.map(toHealth);
  }

  async probe(options: { url?: string; timeoutMs?: number } = {}): Promise<ProxyProbe[]> {
    const url = options.url ?? DEFAULT_PROBE_URL;
    const timeoutMs = options.timeoutMs ?? 10_000;
    // Concurrent: probing 50 proxies serially at a 10s timeout is 8 minutes.
    return Promise.all(this.#entries.map((entry) => probeOne(entry, url, timeoutMs)));
  }
}

export interface GatewayConfig {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  /** Pattern containing `{session}`, e.g. `{username}-session-{session}`. */
  readonly sessionPattern?: string;
  /** How long one sticky identity is reused before rotating. */
  readonly sessionTtlSeconds?: number;
  readonly country?: string;
}

/**
 * A single rotating endpoint that assigns an exit IP per sticky session.
 *
 * Identity is the session token, not the endpoint, so the pool is effectively
 * unbounded and `size` is null. Tokens are recycled while they remain within
 * their TTL, because re-using one keeps the same exit IP — which is what makes
 * cached consent cookies valid.
 */
export class RotatingGatewayProvider implements ProxyProvider {
  readonly mode = 'gateway' as const;
  readonly size = null;

  readonly #config: GatewayConfig;
  readonly #policy: ProxyPolicy;
  readonly #live = new Map<string, Entry>();
  #cooldownUntil: number | null = null;

  constructor(config: GatewayConfig, policy: ProxyPolicy = DEFAULT_POLICY) {
    if (config.server.startsWith('socks')) {
      throw new ConfigError('A sticky-session gateway cannot use SOCKS.', {
        code: 'CONFIG_INVALID',
        hint:
          'Playwright rejects SOCKS proxies with credentials, and the sticky session token ' +
          'is carried in the username. Use the provider’s http:// or https:// endpoint.',
      });
    }
    this.#config = config;
    this.#policy = policy;
  }

  acquire(_purpose: ProxyPurpose, now: number = Date.now()): ProxySession | null {
    // A gateway-wide cooldown means the provider itself is rate-limiting us;
    // spinning up new sessions against it would only make that worse.
    if (this.#cooldownUntil !== null) {
      if (this.#cooldownUntil > now) return null;
      this.#cooldownUntil = null;
    }

    const token = randomBytes(6).toString('hex');
    const username =
      this.#config.sessionPattern !== undefined
        ? stickyUsername(this.#config.sessionPattern, this.#config.username, token)
        : this.#config.username;

    const settings: ProxySettings = {
      server: this.#config.server,
      username,
      password: this.#config.password,
    };

    this.#live.set(token, {
      id: token,
      label: `${this.#config.server} (session ${token})`,
      settings,
      inUse: true,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      blocks: 0,
      cooldownUntil: null,
      lastOutcome: null,
      lastUsedAt: now,
    });

    return {
      id: token,
      settings,
      sessionToken: token,
      ...(this.#config.country !== undefined && { country: this.#config.country }),
      acquiredAt: now,
    };
  }

  release(session: ProxySession, outcome: ProxyOutcome): void {
    const entry = this.#live.get(session.id);
    if (entry !== undefined) {
      entry.inUse = false;
      entry.lastOutcome = outcome;
      if (outcome === 'ok') entry.successes += 1;
      else entry.failures += 1;
    }

    // A blocked sticky session is discarded — its exit IP is burned, and the
    // whole point of the gateway is that another token gets a different one.
    if (outcome === 'blocked') {
      this.#live.delete(session.id);
    }
  }

  /** Bench the entire gateway, e.g. after a 429 from the provider itself. */
  cooldown(now: number = Date.now()): void {
    this.#cooldownUntil = now + this.#policy.banCooldownSeconds * 1000;
  }

  health(): ProxyHealth[] {
    return [...this.#live.values()].map(toHealth);
  }

  async probe(options: { url?: string; timeoutMs?: number } = {}): Promise<ProxyProbe[]> {
    const url = options.url ?? DEFAULT_PROBE_URL;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const session = this.acquire('http');
    if (session === null) {
      return [
        { id: 'gateway', label: this.#config.server, ok: false, error: 'gateway in cooldown' },
      ];
    }
    try {
      return [
        await probeOne(
          { id: session.id, label: `${this.#config.server} (probe)`, settings: session.settings },
          url,
          timeoutMs,
        ),
      ];
    } finally {
      this.release(session, 'ok');
    }
  }
}
