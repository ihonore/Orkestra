/**
 * Browser and context lifecycle.
 *
 * One browser process, N contexts. A context is the unit of *identity*: its own
 * cookies, storage and — critically — its own proxy. Playwright has no
 * `setProxy`, so rotating identity always means closing a context and opening
 * another.
 *
 * The launch is deliberately plain. Setting a launch-level
 * `proxy: { server: 'per-context' }` was required before Playwright 1.47 and is
 * now actively harmful: every context without its own proxy inherits
 * `--proxy-server=http://per-context` and fails with ERR_PROXY_CONNECTION_FAILED,
 * and the auto-added `--proxy-bypass-list=<-loopback>` routes localhost through
 * it too. Verified on 1.62: a plain launch plus per-context proxy works, and a
 * non-proxied context is unaffected.
 */
import type { Browser, BrowserContext, LaunchOptions, Page, Route } from 'playwright';
import { chromium } from 'playwright';
import type { Logger } from '../logging/logger.js';
import { randomViewport } from './humanize.js';
import type { ProxySession } from '../proxy/types.js';

/** Resource kinds that can be blocked to cut bandwidth and latency. */
export type BlockableResource = 'image' | 'media' | 'font' | 'stylesheet';

export interface BrowserPoolOptions {
  readonly headless?: boolean;
  /** Chromium channel, e.g. 'chrome'. Omit to use the bundled build. */
  readonly channel?: string;
  readonly executablePath?: string;
  readonly slowMoMs?: number;
  /** Resource types to abort. Keep CSS and JS — Maps needs both to render. */
  readonly blockResources?: readonly BlockableResource[];
  readonly navigationTimeoutMs?: number;
  readonly actionTimeoutMs?: number;
  /** Contexts to retire after this many jobs, to bound memory growth. */
  readonly jobsPerContext?: number;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly logger?: Logger;
}

export interface LeaseContextOptions {
  readonly proxy?: ProxySession | null;
  /** Cookies/localStorage to seed, keyed by identity by the caller. */
  readonly storageState?: Parameters<Browser['newContext']>[0] extends { storageState?: infer S }
    ? S
    : never;
}

/** A context checked out for one job. */
export interface BrowserLease {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly proxy: ProxySession | null;
  /** Jobs this context has served, including the current one. */
  readonly uses: number;
  /** Return the context. `recycle` forces it closed rather than reused. */
  release(options?: { recycle?: boolean }): Promise<void>;
}

const DEFAULT_BLOCKED: readonly BlockableResource[] = ['image', 'media', 'font'];

/**
 * Chromium flags.
 *
 * `--disable-blink-features=AutomationControlled` removes the most obvious
 * `navigator.webdriver` tell. The rest reduce noise and memory in a headless
 * server context. Deliberately NOT included: `--no-sandbox`, which trades real
 * security for convenience and is only needed in misconfigured containers.
 */
const LAUNCH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',
];

export class BrowserPool {
  #browser: Browser | null = null;
  #contexts = new Set<BrowserContext>();
  #uses = new WeakMap<BrowserContext, number>();
  #closing = false;

  constructor(private readonly options: BrowserPoolOptions = {}) {}

  get isOpen(): boolean {
    return this.#browser !== null && this.#browser.isConnected();
  }

  get openContexts(): number {
    return this.#contexts.size;
  }

  async start(): Promise<void> {
    if (this.#browser !== null) return;

    const launch: LaunchOptions = {
      headless: this.options.headless ?? true,
      args: [...LAUNCH_ARGS],
      ...(this.options.channel !== undefined && { channel: this.options.channel }),
      ...(this.options.executablePath !== undefined && {
        executablePath: this.options.executablePath,
      }),
      ...(this.options.slowMoMs !== undefined && { slowMo: this.options.slowMoMs }),
    };

    this.#browser = await chromium.launch(launch);
    this.options.logger?.debug(
      { headless: launch.headless, channel: this.options.channel },
      'browser launched',
    );
  }

  /**
   * Check out a context and page bound to `proxy`.
   *
   * A fresh context per identity: reusing one across proxies would carry cookies
   * from one exit IP to another, which is both a correlation risk and the reason
   * cached consent state stops working.
   */
  async lease(options: LeaseContextOptions = {}): Promise<BrowserLease> {
    if (this.#browser === null) await this.start();
    const browser = this.#browser;
    if (browser === null) throw new Error('browser failed to start');

    const proxy = options.proxy ?? null;
    const viewport = randomViewport();

    const context = await browser.newContext({
      viewport,
      locale: this.options.locale ?? 'en-US',
      timezoneId: this.options.timezoneId ?? 'America/New_York',
      // Credentials go in their own fields. Playwright rebuilds `server` from
      // protocol and host, silently discarding any `user:pass@` userinfo —
      // verified on 1.62: the proxy then receives no credentials at all, so a
      // sticky-session token embedded that way would be lost and every request
      // would exit from a different IP.
      ...(proxy !== null && proxy.settings.server !== '' && { proxy: proxy.settings }),
      ...(options.storageState !== undefined && { storageState: options.storageState }),
    });

    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs ?? 45_000);
    context.setDefaultTimeout(this.options.actionTimeoutMs ?? 15_000);

    await installEvaluateShims(context);

    const blocked = this.options.blockResources ?? DEFAULT_BLOCKED;
    if (blocked.length > 0) await installResourceBlocking(context, blocked);

    this.#contexts.add(context);
    const uses = (this.#uses.get(context) ?? 0) + 1;
    this.#uses.set(context, uses);

    const page = await context.newPage();

    return {
      context,
      page,
      proxy,
      uses,
      release: async ({ recycle = true } = {}) => {
        this.#contexts.delete(context);
        if (!recycle && !this.#closing) return;
        try {
          await context.close();
        } catch {
          // A context whose browser already died throws here; nothing to do.
        }
      },
    };
  }

  /** Close every context and the browser. Safe to call more than once. */
  async close(): Promise<void> {
    this.#closing = true;
    for (const context of [...this.#contexts]) {
      try {
        await context.close();
      } catch {
        // Ignore: we are tearing down.
      }
    }
    this.#contexts.clear();

    if (this.#browser !== null) {
      try {
        await this.#browser.close();
      } catch {
        // Ignore.
      }
      this.#browser = null;
    }
    this.#closing = false;
  }
}

/**
 * Define helpers that transpiled `page.evaluate` bodies expect to exist.
 *
 * esbuild — which is what `tsx` uses, and therefore what every dev run and every
 * test uses — rewrites named function expressions to call a `__name()` helper so
 * that `Function.prototype.name` survives minification. That helper is emitted
 * into the *Node* module scope, but `page.evaluate` serializes only the function
 * source and runs it in the browser, where the helper does not exist. Any
 * evaluate body containing a named arrow then dies with
 * `ReferenceError: __name is not defined`.
 *
 * It is invisible in a `tsc` build (tsc emits no such helper), so without this
 * the code would work in production and fail in every test — the worst possible
 * split. Defining it as identity in the page costs nothing and fixes both.
 */
async function installEvaluateShims(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope['__name'] ??= (fn: unknown): unknown => fn;
  });
}

/**
 * Abort requests for the given resource types.
 *
 * Worth 3–5x on page load and a large bandwidth saving on metered residential
 * proxies. Stylesheets are blockable but off by default: Maps uses CSS to lay
 * out the results feed, and a feed that never lays out cannot be scrolled.
 */
export async function installResourceBlocking(
  context: BrowserContext,
  kinds: readonly BlockableResource[],
): Promise<void> {
  const blocked = new Set<string>(kinds);
  await context.route('**/*', (route: Route) => {
    if (blocked.has(route.request().resourceType())) {
      void route.abort();
      return;
    }
    void route.continue();
  });
}

/**
 * Visible text of a page, capped.
 *
 * Used for block detection, where only the first screenful matters and pulling a
 * multi-megabyte DOM into Node for a regex would be wasteful.
 */
/* eslint-disable no-restricted-globals --
   The evaluate() callback below runs in the browser, not in Node. */
export async function visibleText(page: Page, maxChars = 4_000): Promise<string> {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return text.slice(0, maxChars);
  } catch {
    // Navigation mid-evaluate, or a closed page.
    return '';
  }
}
/* eslint-enable no-restricted-globals */
