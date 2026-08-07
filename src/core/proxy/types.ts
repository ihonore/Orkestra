/**
 * Proxy identity management.
 *
 * A *session* is one identity: an egress IP, its cookies, and its health record.
 * Rotation means discarding a session and taking a new one — Playwright has no
 * `setProxy`, so a new identity always means a new browser context.
 *
 * ## Playwright proxy rules that are easy to get wrong
 *
 * These are load-bearing; each has bitten someone:
 *
 *  - **Never set a launch-level `proxy: { server: 'per-context' }`.** It was
 *    required before Playwright 1.47 and is now actively harmful: every context
 *    that does not override the proxy inherits `--proxy-server=http://per-context`
 *    and dies with `ERR_PROXY_CONNECTION_FAILED`, and the auto-added
 *    `--proxy-bypass-list=<-loopback>` pushes localhost traffic through it too.
 *    Launch plain; set the proxy per context.
 *
 *  - **Credentials belong in `username`/`password`, never as `user:pass@` in the
 *    server URL.** Playwright rebuilds `server` from protocol and host and drops
 *    the userinfo silently, so a URL-embedded sticky-session token authenticates
 *    as nobody and every request lands on a different exit IP.
 *
 *  - **Sticky-session gateways must be `http://` or `https://`.** Playwright
 *    throws on SOCKS with credentials, which makes username-encoded sticky
 *    sessions impossible over SOCKS.
 *
 *  - Proxy credentials are promoted to the context's `httpCredentials`, so they
 *    are also offered to any *site* issuing an HTTP Basic challenge. That leaks
 *    the proxy username to that origin.
 */
import type { Timestamp } from '../../db/repositories/types.js';

/** What a session is being used for. HTTP-only work need not burn a browser identity. */
export type ProxyPurpose = 'browser' | 'http';

/** How a session ended, which drives health accounting. */
export type ProxyOutcome = 'ok' | 'blocked' | 'error' | 'timeout';

/**
 * Proxy settings in the shape Playwright's `newContext` expects.
 *
 * Deliberately mirrors Playwright rather than inventing a wrapper, so there is
 * no translation step where the credential rules above could be violated.
 */
export interface ProxySettings {
  /** Scheme + host + port only. Must not contain credentials. */
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
  /** Hosts that bypass the proxy, comma-separated. */
  readonly bypass?: string;
}

/** One proxy identity, leased for the duration of a job. */
export interface ProxySession {
  /** Stable id for logging and for keying cached cookies. */
  readonly id: string;
  readonly settings: ProxySettings;
  /**
   * Sticky-session token, when the provider supports one.
   *
   * Cached `storageState` is keyed by this plus the exit country, because a
   * Google consent cookie is per registrable domain and the consent wall is
   * triggered by IP geolocation — the same cookie is not valid from a different
   * exit.
   */
  readonly sessionToken?: string;
  readonly country?: string;
  readonly acquiredAt: Timestamp;
}

export interface ProxyHealth {
  readonly id: string;
  readonly label: string;
  readonly healthy: boolean;
  readonly inUse: boolean;
  readonly successes: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly blocks: number;
  /** Epoch ms until which this identity is benched, or null. */
  readonly cooldownUntil: Timestamp | null;
  readonly lastOutcome: ProxyOutcome | null;
  readonly lastUsedAt: Timestamp | null;
}

/** Result of probing one proxy against an IP-echo endpoint. */
export interface ProxyProbe {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly egressIp?: string;
  readonly country?: string;
  readonly latencyMs?: number;
  readonly error?: string;
}

/**
 * A source of proxy identities.
 *
 * Implementations: {@link NoProxyProvider}, a static list, and a rotating
 * gateway. The engine only ever sees this interface, so switching providers is
 * a config change.
 */
export interface ProxyProvider {
  readonly mode: 'none' | 'list' | 'gateway';
  /** How many distinct identities exist, or null when effectively unbounded. */
  readonly size: number | null;

  /**
   * Take an identity, or `null` when every one is cooling down.
   *
   * `null` means "wait", not "proceed without a proxy" — silently falling back
   * to the host IP is how a residential-proxy setup starts scraping from the
   * office connection without anyone noticing.
   */
  acquire(purpose: ProxyPurpose, now?: Timestamp): ProxySession | null;

  /** Return an identity and record how it went. */
  release(session: ProxySession, outcome: ProxyOutcome, now?: Timestamp): void;

  health(): ProxyHealth[];

  /** Probe every identity against an IP-echo endpoint. */
  probe(options?: { url?: string; timeoutMs?: number }): Promise<ProxyProbe[]>;
}
