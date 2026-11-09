/**
 * Search and results-feed harvesting.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * ## Locale is pinned, not configurable
 *
 * `hl=en` is a constant, not a knob. Three separate mechanisms depend on
 * English: the rating's `aria-label*="star"`, the end-of-list sentinel text, and
 * the consent button labels. Verification observed Google serving a French
 * bundle unprompted to a US-looking request, so this is a live failure mode, not
 * a theoretical one — and it fails *silently*, producing null ratings rather
 * than an error.
 *
 * The region (`gl`) is the one part a campaign may change: it biases which
 * places rank first, not the language of the page.
 *
 * ## Termination is driven by count stagnation
 *
 * Not by `scrollHeight`: Maps virtualizes the feed, so height stops being a
 * function of how much has loaded. Not by the sentinel alone either — no stable
 * structure for it could be verified, and its text is English-only. Counting
 * distinct place links across scroll rounds is the signal that actually works.
 */
import type { Page } from 'playwright';
import { humanPause, jitter, type Range } from '../../core/browser/humanize.js';
import type { Logger } from '../../core/logging/logger.js';
import { feedPlaceLinks, findFeedSelector, hasEndOfList } from './extract/from-dom.js';
import { isPlaceUrl, placeUrlKey } from './extract/from-url.js';

/**
 * Locale parameters applied to every Maps URL.
 *
 * Exported so tests can assert they are present rather than trusting a comment.
 */
export const LOCALE_PARAMS = { hl: 'en', gl: 'us' } as const;

export type SearchMode = 'query' | 'coordinates';

export interface SearchTarget {
  readonly city: string;
  readonly stateCode: string;
  /** The seed city's zip or postal code, for templates that name it. */
  readonly zip?: string;
  readonly category: string;
  readonly lat: number;
  readonly lng: number;
}

export interface BuildUrlOptions {
  readonly mode?: SearchMode;
  /** Template with `{category}`, `{city}`, `{stateCode}`, `{zip}` placeholders. */
  readonly queryTemplate?: string;
  /** Region bias, e.g. `fr`. Default: {@link LOCALE_PARAMS}.gl. */
  readonly gl?: string;
  readonly zoom?: number;
}

export const DEFAULT_QUERY_TEMPLATE = '{category} in {city}, {stateCode}';

/** Render the search phrase for a target. */
export function buildQuery(target: SearchTarget, template = DEFAULT_QUERY_TEMPLATE): string {
  return template
    .replaceAll('{category}', target.category)
    .replaceAll('{city}', target.city)
    .replaceAll('{stateCode}', target.stateCode)
    .replaceAll('{zip}', target.zip ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the Maps URL for a search.
 *
 * `query` mode is the default: one navigation, no typing, and no dependency on
 * the searchbox selector. `coordinates` mode centres the map first and is for
 * when tight geographic control matters more than simplicity.
 */
export function buildSearchUrl(target: SearchTarget, options: BuildUrlOptions = {}): string {
  const query = buildQuery(target, options.queryTemplate);

  if (options.mode === 'coordinates') {
    const zoom = options.zoom ?? 13;
    const url = new URL(`https://www.google.com/maps/@${target.lat},${target.lng},${zoom}z`);
    url.searchParams.set('hl', LOCALE_PARAMS.hl);
    url.searchParams.set('gl', options.gl ?? LOCALE_PARAMS.gl);
    return url.toString();
  }

  const url = new URL(`https://www.google.com/maps/search/${encodeURIComponent(query)}`);
  url.searchParams.set('hl', LOCALE_PARAMS.hl);
  url.searchParams.set('gl', options.gl ?? LOCALE_PARAMS.gl);
  return url.toString();
}

/** Why the scroll loop stopped. Recorded so a truncated harvest is visible. */
export type ScrollStopReason =
  | 'max-listings'
  | 'end-of-list'
  | 'stagnation'
  | 'max-rounds'
  | 'time-budget'
  | 'aborted'
  | 'no-feed';

export interface ScrollResult {
  /** Place URLs in result order, deduplicated by identity. */
  readonly urls: string[];
  readonly rounds: number;
  readonly reason: ScrollStopReason;
  /** True when a cap stopped the harvest, so results may be incomplete. */
  readonly truncated: boolean;
}

export interface ScrollOptions {
  readonly maxListings?: number;
  readonly maxRounds?: number;
  /** Consecutive rounds yielding nothing new before stopping. */
  /** Rounds at the bottom of the list with nothing new before stopping. */
  readonly maxIdleRounds?: number;
  /** How long to wait at the bottom for Maps to fetch the next batch. */
  readonly loadWaitMs?: Range;
  readonly timeBudgetMs?: number;
  readonly stepPx?: Range;
  readonly pauseMs?: Range;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Called after each round with the URLs so far, for checkpointing. */
  readonly onProgress?: (urls: readonly string[], round: number) => void | Promise<void>;
  /** Resume from a previous run's collected URLs. */
  readonly initialUrls?: readonly string[];
}

/**
 * Scroll the results feed, collecting place URLs until a stop condition fires.
 *
 * Deduplication is by place identity ({@link placeUrlKey}), not URL string: the
 * feed re-renders as it scrolls and hands back the same place with different
 * tracking parameters, so string comparison would count it as new forever and
 * stagnation would never trigger.
 */
export async function scrollFeed(page: Page, options: ScrollOptions = {}): Promise<ScrollResult> {
  const maxListings = options.maxListings ?? 120;
  const maxRounds = options.maxRounds ?? 60;
  const maxIdleRounds = options.maxIdleRounds ?? 3;
  const timeBudgetMs = options.timeBudgetMs ?? 180_000;
  const stepPx = options.stepPx ?? [300, 900];
  const pauseMs = options.pauseMs ?? [350, 1_200];
  const loadWaitMs = options.loadWaitMs ?? [1_200, 2_500];

  const seen = new Map<string, string>();
  for (const url of options.initialUrls ?? []) {
    const key = placeUrlKey(url);
    if (key !== null) seen.set(key, url);
  }

  const startedAt = Date.now();
  const feedSelector = await findFeedSelector(page);
  if (feedSelector === null) {
    // No feed at all. Either a single-result page that redirected straight to a
    // place, or a block. The caller distinguishes those.
    return { urls: [...seen.values()], rounds: 0, reason: 'no-feed', truncated: false };
  }

  let rounds = 0;
  let idleRounds = 0;
  // Whether the last scroll left the list at its bottom. Starts true so a list
  // too short to scroll at all can still stop on its first idle rounds.
  let atBottom = true;
  let reason: ScrollStopReason = 'max-rounds';

  for (; rounds < maxRounds; rounds += 1) {
    if (options.signal?.aborted === true) {
      reason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > timeBudgetMs) {
      reason = 'time-budget';
      break;
    }

    const before = seen.size;
    for (const href of await feedPlaceLinks(page)) {
      if (!isPlaceUrl(href)) continue;
      const key = placeUrlKey(href);
      if (key !== null && !seen.has(key)) seen.set(key, href);
    }

    // Stop the moment the cap is reached, mid-round. Scrolling further costs
    // requests against a proxy for results that will be discarded.
    if (seen.size >= maxListings) {
      reason = 'max-listings';
      break;
    }

    await options.onProgress?.([...seen.values()], rounds);

    // A round only counts as idle at the bottom of the list. Maps fetches the
    // next 20 when — and only when — the feed is scrolled to its end, so rounds
    // spent scrolling through what is already loaded find nothing new by
    // design. Counting those stopped searches at their first batch: on real
    // runs, the median "stagnated" search had found exactly 20 places, while
    // searches that reached the end of the list had a median of 107.
    if (seen.size === before && atBottom) {
      idleRounds += 1;
      if (idleRounds >= maxIdleRounds) {
        // Distinguish a genuinely complete list from one that merely stopped
        // yielding, so a truncated harvest is not recorded as complete.
        reason = (await hasEndOfList(page)) ? 'end-of-list' : 'stagnation';
        break;
      }
    } else if (seen.size !== before) {
      idleRounds = 0;
    }

    // Fast path: the sentinel is present and nothing new arrived.
    if (idleRounds > 0 && (await hasEndOfList(page))) {
      reason = 'end-of-list';
      break;
    }

    const pauseOptions = options.signal !== undefined ? { signal: options.signal } : {};
    if (idleRounds > 0) {
      // At the bottom with nothing new: nudge up and back down, so Maps sees a
      // fresh scroll to the end and fetches again, then give it time to.
      await scrollOnce(page, feedSelector, -jitter([120, 260]));
      atBottom = await scrollOnce(page, feedSelector, 1_000_000);
      await humanPause(loadWaitMs, pauseOptions);
    } else {
      atBottom = await scrollOnce(page, feedSelector, jitter(stepPx));
      await humanPause(pauseMs, pauseOptions);
    }
  }

  const urls = [...seen.values()].slice(0, maxListings);
  return {
    urls,
    rounds,
    reason,
    // Only a cap means results were cut short. Reaching the end of the list, or
    // the list ceasing to grow, means we got everything there was.
    truncated: reason === 'max-listings' || reason === 'max-rounds' || reason === 'time-budget',
  };
}

/**
 * Scroll the feed container by `delta` pixels, and report whether it is now at
 * the bottom.
 *
 * `mouse.wheel` would target whatever is under the pointer, which is not
 * reliably the feed. Setting `scrollTop` on the container itself is precise, and
 * the humanization that matters — variable deltas and pauses — is applied by the
 * caller either way.
 */
/* eslint-disable no-restricted-globals --
   The evaluate() callback below runs in the browser, not in Node. */
async function scrollOnce(page: Page, feedSelector: string, delta: number): Promise<boolean> {
  return page.evaluate(
    ([selector, amount]: [string, number]) => {
      const feed = document.querySelector(selector);
      if (feed === null) return true;
      feed.scrollTop += amount;
      // A few pixels of slack: zoom and fractional layout leave scrollTop just
      // short of the exact maximum.
      return feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 8;
    },
    [feedSelector, delta] as [string, number],
  );
}

/* eslint-enable no-restricted-globals */

/**
 * Whether the search resolved directly to one place instead of a list.
 *
 * A specific enough query lands on a place page with no feed, which is a valid
 * single result rather than a failure.
 */
export function isDirectPlaceUrl(url: string): boolean {
  return isPlaceUrl(url);
}
