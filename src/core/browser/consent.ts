/**
 * Google's cookie-consent interstitial.
 *
 * Three hardenings that verification showed are necessary:
 *
 *  1. **The wall is optional.** A run can be redirected straight back with
 *     `?ucbcb=1` and no button at all, so waiting for the button to appear will
 *     hang. Treat absence as success.
 *
 *  2. **Cache the cleared state per exit identity, not globally.** The cookie is
 *     per registrable domain, but the wall is triggered by IP geolocation — so
 *     state cleared from a US exit is not valid from a German one.
 *
 *  3. **Never hardcode a consent cookie value copied from a blog post.** Those
 *     embed a Google build label and rot. Run the flow once per identity and
 *     cache whatever it produces.
 *
 * "Reject all" is chosen over "Accept all" deliberately: it sets fewer cookies,
 * reaches the same content, and is the more defensible default.
 */
import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.js';

export type ConsentResult = 'not-shown' | 'rejected' | 'accepted' | 'failed';

/**
 * Selectors for the reject control, most specific first.
 *
 * `aria-label` and button text are used rather than the hashed class names the
 * legacy flow relied on. Every URL pins `hl=en`, but Google has been seen
 * serving a localised wall anyway — most likely from an EU address — so the
 * French and German labels are listed too.
 */
const REJECT_SELECTORS: readonly string[] = [
  'button[aria-label="Reject all"]',
  'button:has-text("Reject all")',
  'form[action*="consent"] button:has-text("Reject all")',
  '[role="button"]:has-text("Reject all")',
  'button[aria-label="Tout refuser"]',
  'button:has-text("Tout refuser")',
  'button[aria-label="Alle ablehnen"]',
];

const ACCEPT_SELECTORS: readonly string[] = [
  'button[aria-label="Accept all"]',
  'button:has-text("Accept all")',
  'button[aria-label="Tout accepter"]',
  'button:has-text("Tout accepter")',
];

/** Whether the current page is a consent interstitial. */
export function isConsentUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.startsWith('consent.') || pathname.startsWith('/consent');
  } catch {
    return false;
  }
}

export interface ConsentOptions {
  /** Time to wait for a consent control before concluding there is none. */
  readonly timeoutMs?: number;
  readonly preferReject?: boolean;
  readonly logger?: Logger;
}

/**
 * Clear the consent wall if it is present.
 *
 * Returns `not-shown` when there was nothing to do — the common case once an
 * identity has cleared it once and its storage state is being reused.
 */
export async function handleConsent(
  page: Page,
  options: ConsentOptions = {},
): Promise<ConsentResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;

  // Cheap check first: if we are not on a consent URL and no control is
  // present, there is nothing to do. Waiting on a selector that will never
  // appear is how this step turns into a 30-second stall on every job.
  if (!isConsentUrl(page.url())) {
    const present = await hasAnyControl(page, 500);
    if (!present) return 'not-shown';
  }

  const selectors = options.preferReject === false ? ACCEPT_SELECTORS : REJECT_SELECTORS;
  const outcome: ConsentResult = options.preferReject === false ? 'accepted' : 'rejected';

  // One wait for whichever label is on the page, rather than one full wait
  // per label: waiting label by label, a wall that matched none of them cost
  // five seconds per label before the job gave up.
  const selector = selectors.join(', ');
  const control = page.locator(selector).first();
  try {
    await control.waitFor({ state: 'visible', timeout: timeoutMs });
    // The click navigates; waiting for load state rather than a fixed pause
    // means this is as fast as the network allows and still correct.
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined),
      control.click({ timeout: timeoutMs }),
    ]);
    options.logger?.debug({ selector }, 'consent cleared');
    return outcome;
  } catch (error) {
    options.logger?.debug({ err: String(error) }, 'no consent control could be operated');
  }

  // Still on a consent URL with no control we could operate: a real failure.
  return isConsentUrl(page.url()) ? 'failed' : 'not-shown';
}

/** Whether any consent control is visible, waiting once for all of them. */
async function hasAnyControl(page: Page, timeoutMs: number): Promise<boolean> {
  const selector = [...REJECT_SELECTORS, ...ACCEPT_SELECTORS].join(', ');
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache key for a cleared consent state.
 *
 * Both parts matter: the cookie is scoped to the Google host, and whether the
 * wall appears at all depends on the exit IP's country.
 */
export function consentCacheKey(proxyId: string, country = 'unknown', host = 'google.com'): string {
  return `${host}|${country}|${proxyId}`;
}
