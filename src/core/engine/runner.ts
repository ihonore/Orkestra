/**
 * The worker loop.
 *
 * Claim a job, run it, persist what it produced, complete it. Repeat until the
 * queue is empty or a stop condition fires.
 *
 * The invariant that matters: **records and the checkpoint commit in the same
 * transaction**, and both carry the lease's fencing token. A worker that lost
 * its lease writes nothing at all — not the records, not the checkpoint — so a
 * reaped job cannot end up with results from two workers.
 */
import { retryOnBusy } from '../../db/busy.js';
import type { SqliteDriver } from '../../db/driver/types.js';
import { BusinessesRepository } from '../../db/repositories/businesses.js';
import { JobsRepository, failureBackoffMs, type Lease } from '../../db/repositories/jobs.js';
import type { Logger } from '../logging/logger.js';
import { AdaptiveConcurrency } from '../browser/block-detector.js';
import type { ProxyOutcome, ProxyProvider } from '../proxy/types.js';
import { ulid, workerId } from '../util/ids.js';

/** What a job produced, ready to persist. */
export interface JobProduct {
  readonly records: readonly PersistableRecord[];
  readonly cursor: unknown;
}

export interface PersistableRecord {
  readonly business: Parameters<BusinessesRepository['upsert']>[0];
  readonly rank: number | null;
  readonly seedCityId: number | null;
  readonly seedCategoryId: number | null;
  readonly searchQuery: string;
  readonly domain: { readonly name: string; readonly isSocial: boolean } | null;
}

export interface RunStats {
  jobsCompleted: number;
  jobsFailed: number;
  jobsBlocked: number;
  recordsNew: number;
  recordsUpdated: number;
  sightings: number;
  domainsQueued: number;
}

export interface WorkerContext {
  readonly lease: Lease;
  readonly runId: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** Persist records and the checkpoint atomically. Returns false if the lease was lost. */
  readonly commit: (product: JobProduct) => boolean;
  /** Previously stored resume point, if any. */
  readonly checkpoint: <T>() => T | null;
}

export type JobHandlerResult =
  | { readonly kind: 'ok'; readonly resultCount: number }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly errorKind?: string }
  | { readonly kind: 'aborted' };

export type JobHandler = (ctx: WorkerContext) => Promise<JobHandlerResult>;

export interface RunnerOptions {
  readonly driver: SqliteDriver;
  readonly automationId: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly proxies: ProxyProvider;
  readonly handler: JobHandler;
  readonly workers?: number;
  readonly maxJobs?: number;
  readonly leaseSeconds?: number;
  readonly heartbeatSeconds?: number;
  readonly reaperIntervalSeconds?: number;
  readonly adaptive?: { min: number; max: number; blockRateThreshold: number } | null;
  readonly runId?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly stats: RunStats;
  readonly durationMs: number;
  readonly stoppedBecause: 'queue-empty' | 'max-jobs' | 'aborted';
}

/**
 * Persist a job's output.
 *
 * Everything happens inside one IMMEDIATE transaction, and the fence is checked
 * *inside* it via `saveCheckpoint`. If the lease was lost the transaction is
 * rolled back whole, so a fenced-out worker contributes nothing rather than
 * half-writing its results beside the new owner's.
 */
function commitProduct(
  driver: SqliteDriver,
  jobs: JobsRepository,
  businesses: BusinessesRepository,
  lease: Lease,
  runId: string,
  product: JobProduct,
  stats: RunStats,
): boolean {
  return driver.transaction(() => {
    // Fence first: no point doing the work if we no longer own the job.
    if (!jobs.saveCheckpoint(lease, product.cursor)) return false;

    for (const record of product.records) {
      let domainId: number | null = null;
      if (record.domain !== null) {
        domainId = businesses.upsertDomain(record.domain.name, record.domain.isSocial);
        stats.domainsQueued += 1;
      }

      const outcome = businesses.upsert({ ...record.business, domainId, runId });
      if (outcome.created) stats.recordsNew += 1;
      else stats.recordsUpdated += 1;

      businesses.recordSighting({
        businessId: outcome.id,
        jobId: lease.job.id,
        runId,
        seedCityId: record.seedCityId,
        seedCategoryId: record.seedCategoryId,
        searchQuery: record.searchQuery,
        rankInResults: record.rank,
      });
      stats.sightings += 1;
    }

    return true;
  }, 'immediate');
}

/**
 * Drive jobs until the queue drains, the cap is reached, or shutdown begins.
 *
 * Workers are async tasks rather than threads: the work is dominated by network
 * and browser latency, so concurrency comes from overlapping I/O. The database
 * driver is synchronous, and one connection is shared safely because the
 * synchronous API serializes access.
 */
export async function runJobs(options: RunnerOptions): Promise<RunSummary> {
  const runId = options.runId ?? ulid();
  const jobs = new JobsRepository(options.driver);
  const businesses = new BusinessesRepository(options.driver);
  const startedAt = Date.now();

  const leaseMs = (options.leaseSeconds ?? 300) * 1_000;
  const heartbeatMs = (options.heartbeatSeconds ?? 30) * 1_000;
  const reaperMs = (options.reaperIntervalSeconds ?? 60) * 1_000;
  const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;

  const stats: RunStats = {
    jobsCompleted: 0,
    jobsFailed: 0,
    jobsBlocked: 0,
    recordsNew: 0,
    recordsUpdated: 0,
    sightings: 0,
    domainsQueued: 0,
  };

  const adaptive =
    options.adaptive != null
      ? new AdaptiveConcurrency({
          min: options.adaptive.min,
          max: options.adaptive.max,
          start: options.workers ?? 1,
          blockRateThreshold: options.adaptive.blockRateThreshold,
        })
      : null;

  let claimed = 0;
  let stoppedBecause: RunSummary['stoppedBecause'] = 'queue-empty';

  // Recover anything a previous crashed run left leased, then keep sweeping.
  const reclaimed = jobs.reap();
  if (reclaimed.length > 0) {
    options.logger.warn({ count: reclaimed.length }, 'reclaimed leases from a previous run');
  }
  const reaper = setInterval(() => {
    try {
      const ids = jobs.reap();
      if (ids.length > 0) options.logger.warn({ count: ids.length }, 'reaped expired leases');
    } catch (error) {
      options.logger.error({ err: String(error) }, 'reaper failed');
    }
  }, reaperMs);
  reaper.unref?.();

  async function worker(index: number): Promise<void> {
    const owner = workerId(index);
    const log = options.logger.child({ runId, workerId: owner });

    while (!options.signal.aborted) {
      if (claimed >= maxJobs) {
        stoppedBecause = 'max-jobs';
        return;
      }
      // Honour a reduced concurrency target by parking surplus workers.
      if (adaptive !== null && index >= adaptive.current) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }

      const lease = await retryOnBusy(() =>
        jobs.claim({ automationId: options.automationId, owner, leaseMs, runId }),
      );
      if (lease === null) {
        stoppedBecause = claimed >= maxJobs ? 'max-jobs' : 'queue-empty';
        return;
      }
      claimed += 1;

      const jobLog = log.child({ jobId: lease.job.id, taskKey: lease.job.task_key });
      const proxy = options.proxies.acquire('browser');
      let proxyOutcome: ProxyOutcome = 'ok';

      // Keep the lease alive while the job runs. A synchronous DB call can block
      // the loop past a tick, so the lease is set generously longer than the
      // heartbeat and lost heartbeats are tolerated.
      const heartbeat = setInterval(() => {
        try {
          if (!jobs.heartbeat(lease, leaseMs)) {
            jobLog.warn('lease lost while running — results will be discarded');
          }
        } catch (error) {
          jobLog.debug({ err: String(error) }, 'heartbeat failed');
        }
      }, heartbeatMs);
      heartbeat.unref?.();

      try {
        const result = await options.handler({
          lease,
          runId,
          workerId: owner,
          signal: options.signal,
          logger: jobLog,
          commit: (product) =>
            commitProduct(options.driver, jobs, businesses, lease, runId, product, stats),
          checkpoint: <T>() => jobs.checkpoint<T>(lease.job.id),
        });

        switch (result.kind) {
          case 'ok':
            await retryOnBusy(() => jobs.complete(lease, result.resultCount));
            stats.jobsCompleted += 1;
            adaptive?.record(false);
            jobLog.info({ records: result.resultCount }, 'job complete');
            break;

          case 'blocked':
            proxyOutcome = 'blocked';
            stats.jobsBlocked += 1;
            adaptive?.record(true);
            await retryOnBusy(() =>
              jobs.fail(lease, {
                error: result.reason,
                errorKind: 'blocked',
                retryAt: Date.now() + failureBackoffMs(lease.job.attempts, { baseMs: 60_000 }),
              }),
            );
            jobLog.warn({ reason: result.reason }, 'blocked — identity burned, job requeued');
            break;

          case 'failed':
            proxyOutcome = 'error';
            stats.jobsFailed += 1;
            adaptive?.record(false);
            await retryOnBusy(() =>
              jobs.fail(lease, {
                error: result.reason,
                ...(result.errorKind !== undefined && { errorKind: result.errorKind }),
              }),
            );
            jobLog.error({ reason: result.reason }, 'job failed');
            break;

          case 'aborted':
            // Leave the lease to expire: the reaper returns it to pending and
            // the checkpoint means it resumes rather than restarts.
            jobLog.info('job aborted by shutdown');
            break;
        }
      } catch (error) {
        proxyOutcome = 'error';
        stats.jobsFailed += 1;
        await retryOnBusy(() =>
          jobs.fail(lease, { error: String(error), errorKind: 'unhandled' }),
        ).catch(() => undefined);
        jobLog.error({ err: String(error) }, 'job threw');
      } finally {
        clearInterval(heartbeat);
        if (proxy !== null) options.proxies.release(proxy, proxyOutcome);
      }
    }

    stoppedBecause = 'aborted';
  }

  const workerCount = Math.max(1, options.workers ?? 1);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  clearInterval(reaper);

  return {
    runId,
    stats,
    durationMs: Date.now() - startedAt,
    stoppedBecause: options.signal.aborted ? 'aborted' : stoppedBecause,
  };
}
