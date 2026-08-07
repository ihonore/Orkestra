/**
 * SQLITE_BUSY handling.
 *
 * Under WAL, one writer proceeds and the others get SQLITE_BUSY. With eight
 * worker processes claiming from one queue this is not an error condition — it
 * is the normal, expected outcome of contention, and it must be retried rather
 * than propagated.
 *
 * Why not just raise `busy_timeout`? Because SQLite's busy handler *sleeps the
 * calling thread*, and the driver is synchronous, so a 5-second busy timeout
 * freezes the entire process — every worker, every timer, the heartbeat — for
 * up to five seconds. A short timeout plus an async retry here keeps the event
 * loop free between attempts.
 *
 * Note the message text is unreliable ("database is locked"); always classify on
 * the `code` property.
 */

/** Codes that mean "someone else holds the write lock, try again". */
const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT']);

/**
 * Whether an error is lock contention rather than a real failure.
 *
 * `SQLITE_BUSY_SNAPSHOT` is included deliberately: it is what a deferred
 * transaction gets when it has to promote from reader to writer, and SQLite
 * does *not* invoke the busy handler for it — so `busy_timeout` never retries
 * it and only application-level retry will.
 */
export function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && BUSY_CODES.has(code);
}

export interface BusyRetryOptions {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** Base delay; grows exponentially and is jittered. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable for tests. */
  readonly random?: () => number;
}

/**
 * Delay before retry `attempt` (1-based), with full jitter.
 *
 * Jitter is not decoration. Eight workers that back off by the same fixed
 * amount collide again on the same tick; randomising across the whole window
 * spreads them out and is what actually clears the contention.
 */
export function busyBackoffMs(attempt: number, options: BusyRetryOptions = {}): number {
  const base = options.baseDelayMs ?? 5;
  const max = options.maxDelayMs ?? 250;
  const random = options.random ?? Math.random;
  const window = Math.min(base * 2 ** (attempt - 1), max);
  return Math.round(random() * window);
}

/**
 * Run a synchronous database operation, retrying while it reports contention.
 *
 * Async by design: the `await` between attempts returns control to the event
 * loop, so other work proceeds while this caller waits its turn. A synchronous
 * spin would hold the thread and make the contention worse.
 */
export async function retryOnBusy<T>(work: () => T, options: BusyRetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 10;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return work();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, busyBackoffMs(attempt, options)));
      }
    }
  }

  throw lastError;
}
