/**
 * `gms run` — execute queued jobs.
 *
 * Wires the Google Maps automation to the job engine: browser pool, proxy
 * provider, worker loop, checkpointing and graceful shutdown.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { BrowserPool, ownerMarker } from '../../core/browser/pool.js';
import { ArtifactWriter } from '../../core/browser/artifacts.js';
import { runJobs, type JobHandler, type PersistableRecord } from '../../core/engine/runner.js';
import { ShutdownController, sweepOrphanedBrowsers } from '../../core/engine/shutdown.js';
import type { GoogleMapsJobParams } from '../../core/engine/planner.js';
import { createLogger } from '../../core/logging/logger.js';
import { createProxyProvider } from '../../core/proxy/factory.js';
import { ulid } from '../../core/util/ids.js';
import {
  BlockedError,
  INITIAL_CURSOR,
  SelectorRotError,
  runGoogleMapsJob,
  type GoogleMapsCursor,
} from '../../automations/google-maps/index.js';
import { buildQuery, type SearchTarget } from '../../automations/google-maps/search.js';
import type { MergeResult } from '../../automations/google-maps/extract/merge.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { syncQueue } from '../../seeds/queue.js';
import { BusinessesRepository } from '../../db/repositories/businesses.js';
import { MetaRepository } from '../../db/repositories/meta.js';
import { formatDuration, heading, keyValue, style, symbol } from '../output.js';
import path from 'node:path';

/**
 * A promise that resolves after `ms`, without holding the event loop open.
 *
 * `unref` matters: this races a drain that usually wins, and a referenced timer
 * would keep the process alive until the full budget elapsed even after
 * everything else had finished.
 */
function deadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface RunCommandOptions {
  readonly config: ResolvedConfig;
  readonly automationId?: string;
  readonly workers?: number;
  readonly maxJobs?: number;
  readonly headful?: boolean;
  readonly json?: boolean;
}

/** Turn one extracted business into the shape the engine persists. */
function targetOf(params: GoogleMapsJobParams): SearchTarget {
  return {
    city: params.city,
    stateCode: params.stateCode,
    // Jobs planned before the zip was part of the params carry none.
    ...(typeof params.zip === 'string' && { zip: params.zip }),
    category: params.category,
    lat: params.lat,
    lng: params.lng,
  };
}

function toPersistable(
  result: MergeResult,
  params: GoogleMapsJobParams,
  rank: number,
  automationId: string,
  runId: string,
  queryTemplate: string,
): PersistableRecord {
  const b = result.business;
  return {
    rank,
    seedCityId: params.cityId,
    seedCategoryId: params.categoryId,
    // The phrase actually searched, from the same template the job used.
    searchQuery: buildQuery(targetOf(params), queryTemplate),
    // A social profile is recorded but never queued for crawling; a business
    // with no website has no domain row at all.
    domain: b.domain !== null ? { name: b.domain, isSocial: b.domainIsSocial } : null,
    business: {
      cid: b.cid,
      fid: b.fid,
      placeId: b.placeId,
      dedupHash: result.dedupHash,
      name: b.name ?? 'unknown',
      categoryPrimary: b.categoryPrimary,
      categoriesJson: null,
      rating: b.rating,
      reviewsCount: b.reviewsCount,
      phoneRaw: b.phoneRaw,
      phoneE164: b.phoneE164,
      addressRaw: b.addressRaw,
      street: b.street,
      city: b.city,
      stateCode: b.stateCode,
      postalCode: b.postalCode,
      country: b.country,
      lat: b.lat,
      lng: b.lng,
      plusCode: b.plusCode,
      websiteRaw: b.websiteRaw,
      websiteUrl: b.websiteUrl,
      domainId: null, // assigned by the engine after the domain upsert
      gmapsUrl: b.gmapsUrl,
      thumbnailUrl: b.thumbnailUrl,
      hoursJson: b.hoursJson,
      permanentlyClosed: b.permanentlyClosed,
      extractionSource: JSON.stringify(result.provenance),
      // The listing's own panel was read (that is where a DOM name comes from),
      // so what it shows for the website — or that it shows none — is the truth.
      websiteConfirmed: result.provenance.name === 'dom',
      signals: {
        instagramUrl: b.instagramUrl,
        bookingProvider: b.bookingProvider,
        bookingUrl: b.bookingUrl,
        byAppointment: b.byAppointment,
      },
      rawJson: null,
      automationId,
      runId,
    },
  };
}

export async function runRun(options: RunCommandOptions): Promise<void> {
  const { config } = options;
  const automationId = options.automationId ?? 'google-maps';
  const runId = ulid();

  const logger = createLogger({
    level: config.logging.level,
    pretty: config.logging.pretty,
    ...(config.logging.file && {
      file: path.join(config.paths.logsDir, `${runId}.ndjson`),
    }),
    redact: config.logging.redact,
  }).child({ runId, automationId });

  const driver = openDatabaseFromConfig(config);

  // Stable per database, so it identifies browsers this project launched and
  // nobody else's — including a second project on the same machine.
  const installId = new MetaRepository(driver).ensureInstallId();

  // Apply the queue plan before anything is claimed: re-park searches of
  // paused cities that drifted back to pending (released at shutdown, or
  // retried), and order the rest — the order shifts as searches finish.
  if (automationId === 'google-maps') {
    const synced = syncQueue(driver);
    logger.info(synced, 'queue order applied');
  }

  // A previous run killed with SIGKILL (or a closed terminal window) leaves
  // Chromium behind: Playwright's own cleanup never gets to run. Only genuine
  // orphans are killed, so a second `gms run` working the same queue is safe.
  const orphans = await sweepOrphanedBrowsers(ownerMarker(installId), { logger });
  if (orphans.length > 0 && options.json !== true) {
    // Never on the --json path: a line before the summary makes the output
    // unparseable, and the log record carries the same information.
    console.log(
      style.grey(`Cleaned up ${orphans.length} browser process(es) left by an earlier run.`),
    );
  }

  const proxies = createProxyProvider(config);
  const pool = new BrowserPool({
    ownerTag: installId,
    headless: options.headful === true ? false : config.browser.headless,
    ...(config.browser.channel !== undefined && { channel: config.browser.channel }),
    ...(config.browser.executablePath !== undefined && {
      executablePath: config.browser.executablePath,
    }),
    blockResources: config.browser.blockResources,
    navigationTimeoutMs: config.browser.navigationTimeoutMs,
    actionTimeoutMs: config.browser.actionTimeoutMs,
    timezoneId: config.browser.timezoneId,
    logger,
  });
  const artifacts = new ArtifactWriter({ rootDir: config.paths.artifactsDir, runId, logger });

  const shutdown = new ShutdownController({
    graceSeconds: config.runtime.shutdownGraceSeconds,
    logger,
  });

  // Most of the grace goes to the jobs; the rest is reserved for closing the
  // browser, which has to happen inside the same window to be worth anything.
  const graceMs = config.runtime.shutdownGraceSeconds * 1000;
  const drainBudgetMs = Math.max(1_000, Math.floor(graceMs * 0.75));
  shutdown.install();

  // Resolves when the worker loop has actually stopped. Assigned below, once
  // runJobs is running.
  let drained: Promise<unknown> = Promise.resolve();

  shutdown.onShutdown('browser', async () => {
    // Wait for in-flight jobs before taking the browser away. Closing the pool
    // the moment Ctrl-C arrives kills the page a job is mid-scroll on, so the
    // job dies with a navigation error instead of committing the listings it
    // already has and checkpointing where it got to — which is precisely the
    // work the grace period exists to save.
    //
    // The wait is bounded here, not by the controller. Losing the controller's
    // race only logs; it cancels nothing. And closing the pool is the only
    // thing that unwedges a job stuck in a Playwright call — `page.evaluate`
    // has no timeout of its own and returns only when the browser goes away —
    // so waiting for the drain without a deadline of our own would hang the
    // process with Chromium still running.
    await Promise.race([drained, deadline(drainBudgetMs)]);
    await pool.close();
  });

  // The database is deliberately NOT closed here. Shutdown tasks run while
  // workers are still draining, and closing the connection out from under them
  // makes the final jobs fail with "database connection is not open" — losing
  // exactly the results the graceful stop existed to preserve. The `finally`
  // block below closes it once runJobs has actually returned.

  /**
   * Run one job.
   *
   * Records are buffered and committed once at the end of the job rather than
   * per listing: a commit per listing would be ~60 transactions per job, and the
   * checkpoint already makes a mid-job crash resumable.
   */
  const handler: JobHandler = async (ctx) => {
    const params = JSON.parse(ctx.lease.job.params_json) as GoogleMapsJobParams;
    const target = targetOf(params);

    const lease = await pool.lease({ proxy: proxies.acquire('browser') });
    const buffered: PersistableRecord[] = [];
    let cursor: GoogleMapsCursor = ctx.checkpoint<GoogleMapsCursor>() ?? INITIAL_CURSOR;

    try {
      const outcome = await runGoogleMapsJob({
        page: lease.page,
        target,
        search: { queryTemplate: config.market.queryTemplate, gl: config.market.gl },
        country: config.market.country,
        signal: ctx.signal,
        logger: ctx.logger,
        maxListings: 120,
        scrollStepPx: config.humanize.scroll.stepPx,
        scrollPauseMs: config.humanize.scroll.pauseMs,
        delayBetweenListingsMs: config.humanize.delayBetweenListingsMs,
        cursor,
        onCheckpoint: (next) => {
          cursor = next;
        },
        onRecord: (result, rank) => {
          buffered.push(
            toPersistable(
              result,
              params,
              rank,
              automationId,
              ctx.runId,
              config.market.queryTemplate,
            ),
          );
        },
      });

      // One transaction: records plus checkpoint, fenced. A worker that lost its
      // lease writes nothing at all.
      if (!ctx.commit({ records: buffered, cursor })) {
        return { kind: 'failed', reason: 'lease lost — results discarded', errorKind: 'fenced' };
      }

      switch (outcome.kind) {
        case 'ok':
          return { kind: 'ok', resultCount: outcome.extracted };
        case 'blocked':
          return { kind: 'blocked', reason: outcome.verdict.reason ?? 'blocked' };
        case 'unhealthy':
          return { kind: 'failed', reason: outcome.reason, errorKind: 'selector_rot' };
        case 'aborted':
          return { kind: 'aborted' };
      }
    } catch (error) {
      if (error instanceof BlockedError) {
        await artifacts.captureFailure(lease.page, ctx.lease.job.id, { kind: 'blocked' });
        return { kind: 'blocked', reason: error.verdict.reason ?? 'blocked' };
      }
      if (error instanceof SelectorRotError) {
        await artifacts.captureFailure(lease.page, ctx.lease.job.id, {
          kind: 'selector_rot',
          rates: error.rates,
        });
        // Abort the whole run: writing thousands of null rows that look like
        // completed work is strictly worse than stopping loudly.
        ctx.logger.fatal({ rates: error.rates }, error.message);
        void shutdown.shutdown('manual');
        return { kind: 'failed', reason: error.message, errorKind: 'selector_rot' };
      }
      await artifacts.captureFailure(lease.page, ctx.lease.job.id, { error: String(error) });
      return { kind: 'failed', reason: String(error) };
    } finally {
      await lease.release();
    }
  };

  try {
    const running = runJobs({
      driver,
      automationId,
      logger,
      signal: shutdown.signal,
      proxies,
      handler,
      workers: options.workers ?? config.runtime.workers,
      ...(options.maxJobs !== undefined && { maxJobs: options.maxJobs }),
      leaseSeconds: config.runtime.jobLeaseSeconds,
      heartbeatSeconds: config.runtime.heartbeatSeconds,
      reaperIntervalSeconds: config.runtime.reaperIntervalSeconds,
      adaptive: config.runtime.adaptiveConcurrency.enabled
        ? {
            min: config.runtime.adaptiveConcurrency.min,
            max: config.runtime.adaptiveConcurrency.max,
            blockRateThreshold: config.runtime.adaptiveConcurrency.blockRateThreshold,
          }
        : null,
      runId,
    });
    // A rejection is handled by the await below; the shutdown task only needs
    // to know when the loop stopped, not whether it succeeded.
    drained = running.catch(() => undefined);

    const summary = await running;

    const fill = new BusinessesRepository(driver).fillStats();

    if (options.json === true) {
      console.log(JSON.stringify({ ...summary, fill }, null, 2));
      return;
    }

    console.log(heading('Run summary'));
    console.log(
      keyValue([
        ['run', summary.runId],
        ['duration', formatDuration(summary.durationMs)],
        ['stopped', summary.stoppedBecause],
        ['jobs done', String(summary.stats.jobsCompleted)],
        ['jobs failed', String(summary.stats.jobsFailed)],
        ['jobs blocked', String(summary.stats.jobsBlocked)],
        ['new businesses', String(summary.stats.recordsNew)],
        ['updated', String(summary.stats.recordsUpdated)],
        ['sightings', String(summary.stats.sightings)],
        ['domains queued', String(summary.stats.domainsQueued)],
      ]),
    );

    const total = fill['total'] ?? 0;
    if (total > 0) {
      console.log(heading('Extraction fill rates'));
      console.log(
        keyValue(
          (['cid', 'name', 'phone', 'address', 'website', 'rating', 'domain'] as const).map(
            (field) => {
              const n = fill[field] ?? 0;
              const pct = ((n / total) * 100).toFixed(1);
              return [field, `${String(n).padStart(6)} / ${total}  ${pct}%`] as const;
            },
          ),
        ),
      );
    }

    console.log(
      `\n${summary.stats.jobsFailed > 0 ? symbol.warn : symbol.ok} ` +
        `${summary.stats.recordsNew} new businesses from ${summary.stats.jobsCompleted} job(s)`,
    );
    if (summary.stats.jobsFailed > 0) {
      console.log(style.grey('Inspect failures with:  gms jobs list --status failed'));
    }
  } finally {
    shutdown.uninstall();
    await pool.close();
    if (driver.open) driver.close();
    shutdown.exitWhenIdle();
  }
}
