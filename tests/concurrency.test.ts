/**
 * The concurrency and crash-recovery proofs.
 *
 * These spawn real OS processes against one database file, because that is the
 * only configuration in which the leasing statement can actually race. A
 * synchronous driver makes in-process "workers" strictly interleaved, so a
 * single-process test would pass even if the claim were not atomic at all.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { JobsRepository, type JobSpec } from '../src/db/repositories/jobs.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'fixtures', 'claim-worker.ts');
const REPO_ROOT = path.resolve(HERE, '..');

const WORKERS = 8;
const JOB_COUNT = 5_000;

function seedQueue(jobCount: number): string {
  const file = path.join(tempDir(), 'concurrency.sqlite');
  const driver = openDatabase({ file });
  try {
    migrate(driver);
    const specs: JobSpec[] = Array.from({ length: jobCount }, (_, i) => ({
      automationId: 'test',
      taskKey: `task-${i}`,
      params: { i },
    }));
    new JobsRepository(driver).enqueue(specs);
  } finally {
    driver.close();
  }
  return file;
}

const execFileAsync = promisify(execFile);

/**
 * Run one claiming worker to completion, returning the ids it claimed.
 *
 * Async on purpose: `execFileSync` would block the test thread, so the workers
 * would run strictly one after another and the first would drain the queue —
 * a test that spawns 8 processes but never actually contends.
 */
async function runWorker(file: string, owner: string, startAt: number): Promise<number[]> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      WORKER,
      file,
      owner,
      'test',
      String(startAt),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map(Number);
}

describe('concurrent claiming', () => {
  it(`leases each of ${JOB_COUNT} jobs to exactly one of ${WORKERS} processes`, async () => {
    const file = seedQueue(JOB_COUNT);

    // Every worker waits for this instant before its first claim, so process
    // startup cost does not serialize them.
    const startAt = Date.now() + 3_000;
    const batches = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) => runWorker(file, `worker-${i}`, startAt)),
    );

    const all = batches.flat();
    const unique = new Set(all);

    // The assertion that matters: no id appears twice anywhere.
    expect(all.length - unique.size).toBe(0);
    expect(unique.size).toBe(JOB_COUNT);

    // Confirm this was genuinely contended rather than accidentally serial.
    //
    // Not "all 8 claimed something": process startup varies by hundreds of
    // milliseconds under load while the queue drains in tens, so a straggler
    // can legitimately find it empty. What must hold is that several workers
    // really did claim concurrently and none monopolised the queue — with the
    // zero-duplicate assertion above, that is the property under test.
    const busy = batches.filter((b) => b.length > 0).length;
    expect(busy).toBeGreaterThanOrEqual(2);

    const largestShare = Math.max(...batches.map((b) => b.length)) / JOB_COUNT;
    expect(largestShare).toBeLessThan(0.9);

    const driver = openDatabase({ file });
    try {
      const counts = new JobsRepository(driver).counts('test');
      expect(counts).toMatchObject({ pending: 0, leased: 0, done: JOB_COUNT });
    } finally {
      driver.close();
    }
  }, 180_000);
});

describe('crash recovery', () => {
  it('reclaims leases held by a process that died, and resumes from the checkpoint', () => {
    const file = seedQueue(10);
    const driver = openDatabase({ file });

    try {
      const jobs = new JobsRepository(driver);

      // A worker claims three jobs, checkpoints one, then "dies" — no complete,
      // no fail, nothing cleaned up. This is `kill -9` / power loss.
      const dead = [1, 2, 3].map(() =>
        jobs.claim({
          automationId: 'test',
          owner: 'doomed',
          leaseMs: 1000,
          runId: 'r1',
          now: 1000,
        })!,
      );
      jobs.saveCheckpoint(dead[0]!, { processedIndex: 73 }, 1000);
      expect(jobs.counts('test')).toMatchObject({ leased: 3, pending: 7 });

      // On restart the reaper sweeps expired leases back to pending.
      const reclaimed = jobs.reap(5000);
      expect(reclaimed.sort()).toEqual(dead.map((l) => l.job.id).sort());
      expect(jobs.counts('test')).toMatchObject({ leased: 0, pending: 10 });

      // The dead worker's writes are refused even if it comes back.
      expect(jobs.complete(dead[0]!, 99)).toBe(false);

      // A new worker picks the job up and finds the checkpoint intact, so it
      // resumes at listing 73 instead of re-scraping from the start.
      const resumed = jobs.claim({
        automationId: 'test',
        owner: 'fresh',
        leaseMs: 60_000,
        runId: 'r2',
        now: 5000,
      })!;
      expect(jobs.checkpoint(resumed.job.id)).toEqual({ processedIndex: 73 });
      expect(jobs.complete(resumed, 5)).toBe(true);
    } finally {
      driver.close();
    }
  });

  it('does not lose jobs when the reaper and a claimer interleave', () => {
    const file = seedQueue(50);
    const driver = openDatabase({ file });

    try {
      const jobs = new JobsRepository(driver);
      let now = 1000;
      const completed = new Set<number>();

      // Claim with a lease so short it expires immediately, reaping between
      // every claim. Nothing may be completed twice, and nothing may vanish.
      for (let round = 0; round < 200; round += 1) {
        now += 500;
        jobs.reap(now);
        const lease = jobs.claim({
          automationId: 'test',
          owner: `w${round % 4}`,
          leaseMs: 100,
          runId: 'r',
          now,
        });
        if (lease === null) continue;
        // Complete immediately, before the lease can expire.
        if (jobs.complete(lease, 1, 'done', now)) {
          expect(completed.has(lease.job.id)).toBe(false);
          completed.add(lease.job.id);
        }
      }

      const counts = jobs.counts('test');
      expect(counts.done).toBe(completed.size);
      expect(counts.done + counts.pending + counts.leased).toBe(50);
    } finally {
      driver.close();
    }
  });
});
