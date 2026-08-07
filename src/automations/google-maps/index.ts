/**
 * The Google Maps automation.
 *
 * One job = one (city, category) search. The flow is: navigate, clear consent,
 * scroll the feed collecting place URLs, then visit each place and extract from
 * three channels.
 *
 * ## What this file deliberately does not do
 *
 * It never touches the database. It *yields* records and the engine persists
 * them, together with the checkpoint, in one transaction. That is what makes
 * storage pluggable and what prevents the "records saved, checkpoint lost" split
 * that caused the legacy system to re-scrape businesses it already had.
 *
 * ## Why the same page is reused
 *
 * The legacy flow opened a tab per listing and leaked them. Navigating the same
 * page is cheaper, bounds memory, and keeps the XHR listener attached.
 */
import type { Page } from 'playwright';
import { humanPause, type Range } from '../../core/browser/humanize.js';
import { detectBlock, type BlockVerdict } from '../../core/browser/block-detector.js';
import { handleConsent } from '../../core/browser/consent.js';
import { visibleText } from '../../core/browser/pool.js';
import type { Logger } from '../../core/logging/logger.js';
import { extractFromDom } from './extract/from-dom.js';
import { extractFromUrl } from './extract/from-url.js';
import { XhrCollector, isPlaceEndpoint } from './extract/from-xhr.js';
import {
  FillRateTracker,
  checkHealth,
  mergeExtractions,
  type HealthGuardOptions,
  type MergeResult,
} from './extract/merge.js';
import { buildQuery, buildSearchUrl, scrollFeed, type SearchTarget } from './search.js';

/** Resume state, persisted as the job checkpoint. */
export interface GoogleMapsCursor {
  readonly phase: 'search' | 'detail' | 'done';
  /** Place URLs harvested from the feed, in result order. */
  readonly urls: string[];
  /** How many of `urls` have been processed. Resume continues from here. */
  readonly processedIndex: number;
  readonly scrollRounds: number;
}

export const INITIAL_CURSOR: GoogleMapsCursor = {
  phase: 'search',
  urls: [],
  processedIndex: 0,
  scrollRounds: 0,
};

export interface RunJobOptions {
  readonly page: Page;
  readonly target: SearchTarget;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  readonly maxListings?: number;
  readonly maxRounds?: number;
  readonly maxIdleRounds?: number;
  readonly timeBudgetMs?: number;
  readonly scrollStepPx?: Range;
  readonly scrollPauseMs?: Range;
  readonly delayBetweenListingsMs?: Range;
  readonly health?: HealthGuardOptions;
  /** Resume point from a previous attempt. */
  readonly cursor?: GoogleMapsCursor;
  /** Persist progress. The engine writes this in the same transaction as records. */
  readonly onCheckpoint?: (cursor: GoogleMapsCursor) => void | Promise<void>;
  /** Called for each extracted business, in result order. */
  readonly onRecord?: (result: MergeResult, rank: number) => void | Promise<void>;
}

export type JobOutcome =
  | { readonly kind: 'ok'; readonly extracted: number; readonly truncated: boolean }
  | { readonly kind: 'blocked'; readonly verdict: BlockVerdict }
  | { readonly kind: 'unhealthy'; readonly reason: string }
  | { readonly kind: 'aborted'; readonly extracted: number };

/** Errors that mean "this identity is burned", distinct from ordinary failure. */
export class BlockedError extends Error {
  constructor(readonly verdict: BlockVerdict) {
    super(`blocked: ${verdict.reason ?? 'unknown'}`);
    this.name = 'BlockedError';
  }
}

/**
 * Selector rot detected mid-run.
 *
 * Aborting is the point: the legacy system had no such guard and wrote thousands
 * of null rows that looked like completed work. A failed run gets re-run; a run
 * that "succeeded" with empty data does not.
 */
export class SelectorRotError extends Error {
  constructor(
    message: string,
    readonly rates: Record<string, number>,
  ) {
    super(message);
    this.name = 'SelectorRotError';
  }
}

/** Check the current page for a block, throwing if one is found. */
async function assertNotBlocked(page: Page, consentAttempts: number): Promise<void> {
  const verdict = detectBlock({
    url: page.url(),
    bodyText: await visibleText(page, 2_000),
    consentAttempts,
  });
  if (verdict.blocked) throw new BlockedError(verdict);
}

/**
 * Run one (city, category) job to completion.
 *
 * Resumable: pass the previous `cursor` and it continues from `processedIndex`
 * without re-scrolling or re-extracting.
 */
export async function runGoogleMapsJob(options: RunJobOptions): Promise<JobOutcome> {
  const { page, target, logger } = options;
  const query = buildQuery(target);
  const tracker = new FillRateTracker();

  let cursor: GoogleMapsCursor = options.cursor ?? INITIAL_CURSOR;
  let consentAttempts = 0;

  // Registered before any navigation: place payloads arrive during load, and a
  // listener attached afterwards misses them entirely.
  const xhr = new XhrCollector();
  const onResponse = (response: { url: () => string; text: () => Promise<string> }): void => {
    if (!isPlaceEndpoint(response.url())) return;
    void response
      .text()
      .then((body) => xhr.add(body))
      .catch(() => undefined);
  };
  page.on('response', onResponse);

  try {
    // ── Phase 1: search and harvest the feed ─────────────────────────────────
    if (cursor.phase === 'search') {
      await page.goto(buildSearchUrl(target), { waitUntil: 'domcontentloaded' });

      const consent = await handleConsent(page, logger !== undefined ? { logger } : {});
      if (consent === 'rejected' || consent === 'accepted') consentAttempts += 1;
      if (consent === 'failed') consentAttempts += 2;

      await assertNotBlocked(page, consentAttempts);

      // Wait for the feed to render before scrolling. Without this the harvest
      // runs against a half-built list and collects a fraction of the results —
      // measured on a live Birmingham search: 1 link immediately, 11 after the
      // feed settled. Waiting on the element rather than a fixed pause keeps it
      // as fast as the network allows.
      await page
        .locator('div[role="feed"]')
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .catch(() => undefined);

      const scroll = await scrollFeed(page, {
        ...(options.maxListings !== undefined && { maxListings: options.maxListings }),
        ...(options.maxRounds !== undefined && { maxRounds: options.maxRounds }),
        ...(options.maxIdleRounds !== undefined && { maxIdleRounds: options.maxIdleRounds }),
        ...(options.timeBudgetMs !== undefined && { timeBudgetMs: options.timeBudgetMs }),
        ...(options.scrollStepPx !== undefined && { stepPx: options.scrollStepPx }),
        ...(options.scrollPauseMs !== undefined && { pauseMs: options.scrollPauseMs }),
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(logger !== undefined && { logger }),
        initialUrls: cursor.urls,
      });

      if (scroll.reason === 'no-feed') {
        // No feed: either the query resolved straight to one place, or we were
        // blocked. assertNotBlocked already ruled out the latter.
        const direct = page.url();
        scroll.urls.push(direct);
      }

      logger?.info(
        { query, found: scroll.urls.length, rounds: scroll.rounds, reason: scroll.reason },
        'feed harvested',
      );

      cursor = {
        phase: 'detail',
        urls: scroll.urls,
        processedIndex: 0,
        scrollRounds: scroll.rounds,
      };
      await options.onCheckpoint?.(cursor);

      if (scroll.truncated) {
        logger?.warn(
          { query, reason: scroll.reason, collected: scroll.urls.length },
          'harvest stopped at a cap — results may be incomplete',
        );
      }
    }

    // ── Phase 2: visit each place and extract ────────────────────────────────
    let extracted = 0;

    for (let index = cursor.processedIndex; index < cursor.urls.length; index += 1) {
      if (options.signal?.aborted === true) {
        return { kind: 'aborted', extracted };
      }

      const placeUrl = cursor.urls[index];
      if (placeUrl === undefined) continue;

      xhr.clear();
      await page.goto(placeUrl, { waitUntil: 'domcontentloaded' });

      // The panel element appears well before its contents do, so waiting for
      // the panel alone yields a business with a name and nothing else. Wait for
      // an actual detail row — `data-item-id` marks address, phone and website —
      // which is the signal that the panel has populated.
      await page
        .locator('div[role="main"][aria-label]')
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 })
        .catch(() => undefined);
      await page
        .locator('[data-item-id]')
        .first()
        .waitFor({ state: 'attached', timeout: 8_000 })
        .catch(() => undefined);

      await assertNotBlocked(page, consentAttempts);

      const merged = mergeExtractions({
        url: extractFromUrl(page.url()),
        xhr: xhr.best(),
        dom: await extractFromDom(page),
        gmapsUrl: page.url(),
      });

      // A listing with no name at all did not parse; count it for the health
      // guard but do not store a nameless row.
      tracker.record(merged);
      if (merged.business.name !== null) {
        await options.onRecord?.(merged, index + 1);
        extracted += 1;
      }

      const health = checkHealth(tracker, options.health ?? {});
      if (!health.healthy) {
        throw new SelectorRotError(health.reason ?? 'extraction health check failed', health.rates);
      }

      cursor = { ...cursor, processedIndex: index + 1 };
      await options.onCheckpoint?.(cursor);

      await humanPause(
        options.delayBetweenListingsMs ?? [400, 1_400],
        options.signal !== undefined ? { signal: options.signal } : {},
      );
    }

    await options.onCheckpoint?.({ ...cursor, phase: 'done' });
    return { kind: 'ok', extracted, truncated: false };
  } finally {
    page.off('response', onResponse);
  }
}
