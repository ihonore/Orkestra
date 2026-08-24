import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { JobsRepository, type JobSpec, type Lease } from '../src/db/repositories/jobs.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

function freshQueue(): { jobs: JobsRepository; driver: SqliteDriver; file: string } {
  const file = path.join(tempDir(), 'queue.sqlite');
  const driver = openDatabase({ file });
  migrate(driver);
  return { jobs: new JobsRepository(driver), driver, file };
}

function specs(count: number, automationId = 'test'): JobSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    automationId,
    taskKey: `task-${i}`,
    params: { index: i },
  }));
}

const CLAIM = { automationId: 'test', owner: 'w1', leaseMs: 60_000, runId: 'run-1' };

describe('enqueue', () => {
  it('is idempotent on (automationId, taskKey)', () => {
    const { jobs, driver } = freshQueue();
    try {
      expect(jobs.enqueue(specs(100))).toEqual({ inserted: 100, skipped: 0 });
      // Re-planning must not duplicate work.
      expect(jobs.enqueue(specs(100))).toEqual({ inserted: 0, skipped: 100 });
      expect(jobs.counts('test').pending).toBe(100);
    } finally {
      driver.close();
    }
  });

  it('adds only the new jobs when the seed set grows', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(10));
      expect(jobs.enqueue(specs(15))).toEqual({ inserted: 5, skipped: 10 });
    } finally {
      driver.close();
    }
  });

  it('round-trips job params', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'k', params: { city: 'Boston', n: 3 } }]);
      const job = jobs.byTaskKey('test', 'k');
      expect(JSON.parse(job!.params_json)).toEqual({ city: 'Boston', n: 3 });
    } finally {
      driver.close();
    }
  });
});

describe('claim', () => {
  it('leases each job to exactly one caller', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(500));

      const seen = new Set<number>();
      for (;;) {
        const lease = jobs.claim(CLAIM);
        if (lease === null) break;
        expect(seen.has(lease.job.id)).toBe(false);
        seen.add(lease.job.id);
      }

      expect(seen.size).toBe(500);
      expect(jobs.counts('test')).toMatchObject({ pending: 0, leased: 500 });
    } finally {
      driver.close();
    }
  });

  it('returns null on an empty queue rather than throwing', () => {
    const { jobs, driver } = freshQueue();
    try {
      expect(jobs.claim(CLAIM)).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('does not claim jobs scheduled in the future', () => {
    const { jobs, driver } = freshQueue();
    try {
      const now = Date.now();
      jobs.enqueue([
        { automationId: 'test', taskKey: 'later', params: {}, scheduledAt: now + 60_000 },
      ]);
      expect(jobs.claim({ ...CLAIM, now })).toBeNull();
      // ...but does once its time arrives.
      expect(jobs.claim({ ...CLAIM, now: now + 61_000 })).not.toBeNull();
    } finally {
      driver.close();
    }
  });

  it('claims in priority order, highest first', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([
        { automationId: 'test', taskKey: 'low', params: {}, priority: 1 },
        { automationId: 'test', taskKey: 'high', params: {}, priority: 100 },
        { automationId: 'test', taskKey: 'mid', params: {}, priority: 50 },
      ]);
      expect(jobs.claim(CLAIM)?.job.task_key).toBe('high');
      expect(jobs.claim(CLAIM)?.job.task_key).toBe('mid');
      expect(jobs.claim(CLAIM)?.job.task_key).toBe('low');
    } finally {
      driver.close();
    }
  });

  it('does not cross automation boundaries', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(5, 'other'));
      expect(jobs.claim(CLAIM)).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('increments attempts and stamps the run', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      expect(lease.job.attempts).toBe(1);
      expect(lease.job.first_run_id).toBe('run-1');
      expect(lease.job.lease_epoch).toBe(1);
    } finally {
      driver.close();
    }
  });
});

describe('fencing token', () => {
  /** Claim a job, then let the reaper hand it to someone else. */
  function stealJob(jobs: JobsRepository): { stale: Lease; fresh: Lease } {
    jobs.enqueue(specs(1));
    const stale = jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 })!;
    // Reaper runs after the lease expires and bumps the epoch.
    expect(jobs.reap(5000)).toEqual([stale.job.id]);
    const fresh = jobs.claim({ ...CLAIM, owner: 'w2', now: 5000 })!;
    return { stale, fresh };
  }

  it('gives the new owner a different epoch', () => {
    const { jobs, driver } = freshQueue();
    try {
      const { stale, fresh } = stealJob(jobs);
      expect(fresh.job.id).toBe(stale.job.id);
      expect(fresh.epoch).toBeGreaterThan(stale.epoch);
    } finally {
      driver.close();
    }
  });

  it('rejects every write from the stale owner', () => {
    const { jobs, driver } = freshQueue();
    try {
      const { stale } = stealJob(jobs);

      // This is the whole point: a worker that merely stalled must not be able
      // to write results alongside the job's new owner.
      expect(jobs.heartbeat(stale, 60_000)).toBe(false);
      expect(jobs.saveCheckpoint(stale, { at: 73 })).toBe(false);
      expect(jobs.complete(stale, 42)).toBe(false);
      expect(jobs.fail(stale, { error: 'stale' })).toBe(false);
    } finally {
      driver.close();
    }
  });

  it('still accepts writes from the current owner', () => {
    const { jobs, driver } = freshQueue();
    try {
      const { fresh } = stealJob(jobs);
      expect(jobs.heartbeat(fresh, 60_000)).toBe(true);
      expect(jobs.saveCheckpoint(fresh, { at: 1 })).toBe(true);
      expect(jobs.complete(fresh, 7)).toBe(true);
      expect(jobs.byId(fresh.job.id)?.status).toBe('done');
      expect(jobs.byId(fresh.job.id)?.result_count).toBe(7);
    } finally {
      driver.close();
    }
  });

  it('fences out a worker whose job an operator retried underneath it', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      jobs.retry({ automationId: 'test', status: 'leased' });
      expect(jobs.complete(lease)).toBe(false);
    } finally {
      driver.close();
    }
  });
});

describe('reaper', () => {
  it('returns expired leases to pending', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(3));
      for (let i = 0; i < 3; i += 1) jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 });
      expect(jobs.counts('test').leased).toBe(3);

      expect(jobs.reap(5000)).toHaveLength(3);
      expect(jobs.counts('test')).toMatchObject({ pending: 3, leased: 0 });
      expect(jobs.byId(1)?.last_error_kind).toBe('lease_expired');
    } finally {
      driver.close();
    }
  });

  it('leaves live leases alone', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(2));
      jobs.claim({ ...CLAIM, leaseMs: 60_000, now: 1000 });
      expect(jobs.reap(2000)).toEqual([]);
      expect(jobs.counts('test').leased).toBe(1);
    } finally {
      driver.close();
    }
  });

  it('lets a heartbeat keep a long job alive', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 })!;

      expect(jobs.heartbeat(lease, 1000, 1500)).toBe(true);
      // Would have expired at 2000 without the heartbeat; now expires at 2500.
      expect(jobs.reap(2200)).toEqual([]);
      expect(jobs.reap(2600)).toEqual([lease.job.id]);
    } finally {
      driver.close();
    }
  });
});

describe('failure and retry', () => {
  it('retries until max_attempts, then gives up', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'flaky', params: {}, maxAttempts: 3 }]);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const lease = jobs.claim(CLAIM)!;
        expect(lease.job.attempts).toBe(attempt);
        expect(jobs.fail(lease, { error: `attempt ${attempt}`, retryAt: 0 })).toBe(true);

        const after = jobs.byId(lease.job.id)!;
        expect(after.status).toBe(attempt < 3 ? 'pending' : 'failed');
      }

      expect(jobs.claim(CLAIM)).toBeNull();
      expect(jobs.counts('test').failed).toBe(1);
    } finally {
      driver.close();
    }
  });

  it('honours the backoff window before retrying', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim({ ...CLAIM, now: 1000 })!;
      jobs.fail(lease, { error: 'transient', retryAt: 10_000, now: 1000 });

      expect(jobs.claim({ ...CLAIM, now: 5000 })).toBeNull();
      expect(jobs.claim({ ...CLAIM, now: 10_000 })).not.toBeNull();
    } finally {
      driver.close();
    }
  });

  it('clears the lease when a job fails, so the reaper has nothing to do', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      jobs.fail(lease, { error: 'boom' });

      const after = jobs.byId(lease.job.id)!;
      expect(after.lease_owner).toBeNull();
      expect(after.lease_expires_at).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('resets attempts on an operator retry so it is not instantly exhausted', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'x', params: {}, maxAttempts: 1 }]);
      const lease = jobs.claim(CLAIM)!;
      jobs.fail(lease, { error: 'dead' });
      expect(jobs.byId(1)?.status).toBe('failed');

      expect(jobs.retry({ automationId: 'test' })).toBe(1);
      const after = jobs.byId(1)!;
      expect(after.status).toBe('pending');
      expect(after.attempts).toBe(0);
      expect(after.last_error).toBeNull();
    } finally {
      driver.close();
    }
  });
});

describe('release on shutdown', () => {
  it('makes an interrupted job immediately claimable again', () => {
    // Leaving the lease to expire instead means the job is invisible for the
    // whole of jobLeaseSeconds: the claim only sees 'pending' and the reaper
    // only sees expired leases. Stop a run and restart it, and the queue looks
    // empty while every in-flight job sits idle for five minutes.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'interrupted', params: {} }]);
      const lease = jobs.claim(CLAIM)!;

      expect(jobs.release(lease)).toBe(true);
      expect(jobs.byId(lease.job.id)!.status).toBe('pending');
      expect(jobs.claim(CLAIM)?.job.id).toBe(lease.job.id);
    } finally {
      driver.close();
    }
  });

  it('keeps the checkpoint, so the job resumes rather than restarts', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'interrupted', params: {} }]);
      const lease = jobs.claim(CLAIM)!;
      jobs.saveCheckpoint(lease, { processedIndex: 73 });

      jobs.release(lease);

      const next = jobs.claim(CLAIM)!;
      expect(jobs.checkpoint(next.job.id)).toEqual({ processedIndex: 73 });
    } finally {
      driver.close();
    }
  });

  it('costs no error and no backoff, because nothing went wrong', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'interrupted', params: {} }]);
      const lease = jobs.claim(CLAIM)!;
      jobs.release(lease);

      const after = jobs.byId(lease.job.id)!;
      expect(after.last_error).toBeNull();
      expect(after.attempts).toBe(1); // the one it already spent, not a second
    } finally {
      driver.close();
    }
  });

  it('is fenced, so a worker that lost its lease cannot un-claim it', () => {
    // The hazard the reaper creates: the old owner may still be alive.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'interrupted', params: {} }]);
      const stale = jobs.claim(CLAIM)!;

      driver.prepare(`UPDATE jobs SET lease_expires_at = 1 WHERE id = ?`).run([stale.job.id]);
      jobs.reap();
      const fresh = jobs.claim(CLAIM)!;

      expect(jobs.release(stale)).toBe(false);
      expect(jobs.byId(fresh.job.id)!.status).toBe('leased');
    } finally {
      driver.close();
    }
  });
});

describe('checkpoints', () => {
  it('round-trips a resume cursor', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      const cursor = { phase: 'detail', processedIndex: 73, urls: ['a', 'b'] };

      expect(jobs.saveCheckpoint(lease, cursor)).toBe(true);
      expect(jobs.checkpoint(lease.job.id)).toEqual(cursor);
    } finally {
      driver.close();
    }
  });

  it('overwrites rather than accumulating', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      jobs.saveCheckpoint(lease, { at: 1 });
      jobs.saveCheckpoint(lease, { at: 2 });
      expect(jobs.checkpoint(lease.job.id)).toEqual({ at: 2 });
    } finally {
      driver.close();
    }
  });

  it('survives the reaper, so a resumed job continues where it stopped', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 })!;
      jobs.saveCheckpoint(lease, { processedIndex: 73 }, 1000);

      jobs.reap(5000);
      const resumed = jobs.claim({ ...CLAIM, owner: 'w2', now: 5000 })!;
      expect(jobs.checkpoint(resumed.job.id)).toEqual({ processedIndex: 73 });
    } finally {
      driver.close();
    }
  });

  it('returns null when there is no checkpoint', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      expect(jobs.checkpoint(1)).toBeNull();
    } finally {
      driver.close();
    }
  });
});

/**
 * Regressions for defects found by adversarial audit of the leasing design.
 * Each of these was reproduced against the real repository before being fixed.
 */
describe('audit regressions', () => {
  it('bounds a poison job that kills its worker before it can report failure', () => {
    // attempts are spent by claim(), but only fail() used to enforce
    // max_attempts — so a job whose worker dies was reclaimed forever. Measured
    // before the fix: 10 claims of a max_attempts=3 job, still 'pending'.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'poison', params: {}, maxAttempts: 3 }]);

      let now = 1000;
      let claims = 0;
      for (let round = 0; round < 10; round += 1) {
        if (jobs.claim({ ...CLAIM, leaseMs: 100, now }) !== null) claims += 1;
        now += 1000;
        jobs.reap(now); // the worker died: never completed, never failed
      }

      expect(claims).toBe(3);
      expect(jobs.byId(1)).toMatchObject({ status: 'failed', attempts: 3 });
    } finally {
      driver.close();
    }
  });

  it('treats retry({ ids: [] }) as "nothing", never as "everything"', () => {
    // An empty resolved selection used to fall through to the default filter
    // and reset the entire failed backlog.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([
        { automationId: 'test', taskKey: 'a', params: {}, maxAttempts: 1 },
        { automationId: 'test', taskKey: 'b', params: {}, maxAttempts: 1 },
      ]);
      for (let i = 0; i < 2; i += 1) jobs.fail(jobs.claim(CLAIM)!, { error: 'x' });
      expect(jobs.counts('test').failed).toBe(2);

      expect(jobs.retry({ ids: [] })).toBe(0);
      expect(jobs.counts('test').failed).toBe(2);
    } finally {
      driver.close();
    }
  });

  it('leaves healthy in-flight work alone on a routine retry', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const live = jobs.claim(CLAIM)!;
      expect(jobs.retry({ automationId: 'test' })).toBe(0);
      expect(jobs.complete(live)).toBe(true);
    } finally {
      driver.close();
    }
  });

  it('fences a leased job when an operator names it explicitly', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const live = jobs.claim(CLAIM)!;
      expect(jobs.retry({ ids: [live.job.id] })).toBe(1);
      expect(jobs.complete(live)).toBe(false);
    } finally {
      driver.close();
    }
  });

  it('clears the checkpoint on retry, so the job restarts rather than resuming', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'z', params: {}, maxAttempts: 1 }]);
      const lease = jobs.claim(CLAIM)!;
      jobs.saveCheckpoint(lease, { processedIndex: 73 });
      jobs.fail(lease, { error: 'x' });

      jobs.retry({ automationId: 'test' });
      expect(jobs.checkpoint(lease.job.id)).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('backs off by default, so a failing job does not spin through its budget', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'f', params: {}, maxAttempts: 5 }]);
      const lease = jobs.claim({ ...CLAIM, now: 1000 })!;
      jobs.fail(lease, { error: 'transient', now: 1000 });

      // No retryAt given: must not be instantly re-claimable.
      expect(jobs.claim({ ...CLAIM, now: 1000 })).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('scopes counts to the automation named, even when that name is empty', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(3, 'other'));
      expect(jobs.counts('').pending).toBe(0);
      expect(jobs.counts('other').pending).toBe(3);
    } finally {
      driver.close();
    }
  });

  it('fences saveCheckpoint atomically rather than checking then writing', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const stale = jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 })!;
      jobs.reap(5000);
      const fresh = jobs.claim({ ...CLAIM, owner: 'w2', now: 5000 })!;

      jobs.saveCheckpoint(fresh, { x: 2 });
      expect(jobs.saveCheckpoint(stale, { x: 1 })).toBe(false);
      // The stale worker's cursor must not have overwritten the new owner's.
      expect(jobs.checkpoint(fresh.job.id)).toEqual({ x: 2 });
    } finally {
      driver.close();
    }
  });

  it('rejects a lease duration that would strand the job forever', () => {
    // A non-finite lease stored lease_expires_at = NULL, which the reaper's
    // `lease_expires_at < now` can never match.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      expect(() => jobs.claim({ ...CLAIM, leaseMs: Number.NaN })).toThrowError(/positive finite/);
      expect(() => jobs.claim({ ...CLAIM, leaseMs: 0 })).toThrowError(/positive finite/);
    } finally {
      driver.close();
    }
  });

  it('replaces the error text when the reaper takes a job, not just the kind', () => {
    // Leaving last_error behind made `jobs list --error-kind lease_expired`
    // show a message from an earlier, unrelated failure.
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue([{ automationId: 'test', taskKey: 'j', params: {}, maxAttempts: 5 }]);
      jobs.fail(jobs.claim({ ...CLAIM, now: 1000 })!, {
        error: 'HTTP 429 from google',
        errorKind: 'rate_limited',
        retryAt: 0,
        now: 1000,
      });

      const second = jobs.claim({ ...CLAIM, leaseMs: 100, now: 2000 })!;
      jobs.reap(9000);

      const after = jobs.byId(second.job.id)!;
      expect(after.last_error_kind).toBe('lease_expired');
      expect(after.last_error).not.toContain('429');
    } finally {
      driver.close();
    }
  });

  it('truncates a long error without splitting an emoji into a lone surrogate', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(1));
      const lease = jobs.claim(CLAIM)!;
      jobs.fail(lease, { error: 'x'.repeat(1999) + '\u{1F600}' });

      const stored = jobs.byId(lease.job.id)!.last_error!;
      expect(stored).not.toContain('�');
      expect(stored.length).toBe(1999);
    } finally {
      driver.close();
    }
  });

  it('chunks a large id list instead of exceeding SQLite parameter limits', () => {
    const { jobs, driver } = freshQueue();
    try {
      const count = 1200;
      jobs.enqueue(
        Array.from({ length: count }, (_, i) => ({
          automationId: 'test',
          taskKey: `t${i}`,
          params: {},
          maxAttempts: 1,
        })),
      );
      for (let i = 0; i < count; i += 1) jobs.fail(jobs.claim(CLAIM)!, { error: 'x' });

      const ids = Array.from({ length: count }, (_, i) => i + 1);
      expect(jobs.retry({ ids })).toBe(count);
    } finally {
      driver.close();
    }
  });

  it('makes the unrecoverable leased-without-expiry state impossible', () => {
    const { driver } = freshQueue();
    try {
      driver
        .prepare(
          `INSERT INTO jobs (automation_id, task_key, params_json, created_at, updated_at)
           VALUES ('t', 'k', '{}', 1, 1)`,
        )
        .run();
      expect(() =>
        driver
          .prepare(`UPDATE jobs SET status='leased', lease_owner=NULL, lease_expires_at=NULL`)
          .run(),
      ).toThrowError(/CHECK constraint failed/);
    } finally {
      driver.close();
    }
  });
});

describe('counts and listing', () => {
  it('reports every status, including zeros', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(3));
      expect(jobs.counts('test')).toEqual({
        pending: 3,
        leased: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        paused: 0,
      });
    } finally {
      driver.close();
    }
  });

  it('filters by status and error kind', () => {
    const { jobs, driver } = freshQueue();
    try {
      jobs.enqueue(specs(5));
      const lease = jobs.claim({ ...CLAIM, leaseMs: 1000, now: 1000 })!;
      jobs.reap(5000);

      expect(jobs.list({ status: 'pending' })).toHaveLength(5);
      expect(jobs.list({ errorKind: 'lease_expired' }).map((j) => j.id)).toEqual([lease.job.id]);
    } finally {
      driver.close();
    }
  });
});
