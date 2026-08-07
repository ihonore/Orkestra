/**
 * A single claiming worker, run as its own OS process by the concurrency test.
 *
 * Separate processes are the only honest way to test this. better-sqlite3 is
 * synchronous, so "8 workers" inside one process are interleaved, never
 * simultaneous — they could never expose a genuine race on the write lock.
 *
 * Usage: tsx claim-worker.ts <dbFile> <owner> <automationId> <startAtEpochMs>
 * Writes the ids it claimed to stdout, one per line.
 */
import { retryOnBusy } from '../../src/db/busy.js';
import { openDatabase } from '../../src/db/client.js';
import { JobsRepository } from '../../src/db/repositories/jobs.js';

const [, , file, owner, automationId, startAt] = process.argv;
if (file === undefined || owner === undefined || automationId === undefined) {
  console.error('usage: claim-worker.ts <dbFile> <owner> <automationId> [startAtEpochMs]');
  process.exit(2);
}

// Wall-clock start barrier. Process startup costs far more than draining the
// queue does, so without this the first worker to boot finishes everything and
// the rest find an empty queue — a test that spawns 8 processes and measures
// nothing. Waiting for a shared instant makes them actually collide.
if (startAt !== undefined) {
  const waitMs = Number(startAt) - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// A short busy timeout, as the app uses: the handler sleeps the thread, so a
// long one would stall this worker instead of letting it retry.
const driver = openDatabase({ file, busyTimeoutMs: 250 });
const jobs = new JobsRepository(driver);
const claimed: number[] = [];

try {
  for (;;) {
    // SQLITE_BUSY is the normal outcome of eight processes contending for one
    // write lock, not a failure. Classify on error.code — the message is just
    // "database is locked".
    const lease = await retryOnBusy(() =>
      jobs.claim({ automationId, owner, leaseMs: 60_000, runId: 'concurrency-test' }),
    );
    if (lease === null) break;
    claimed.push(lease.job.id);
    await retryOnBusy(() => jobs.complete(lease, 0));
  }
  process.stdout.write(claimed.join('\n'));
} finally {
  driver.close();
}
