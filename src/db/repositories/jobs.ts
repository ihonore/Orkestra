/**
 * The job queue.
 *
 * A job is one unit of work — for Google Maps, one (city, category) pair. The
 * queue is what turns "scrape 15,725 searches" into something that survives a
 * crash, runs on N workers, and can be inspected and resumed.
 *
 * ## The leasing contract
 *
 * `claim()` hands out a {@link Lease}. That lease carries a **fencing token**
 * (`epoch`), and every subsequent write about the job — heartbeat, checkpoint,
 * complete, fail — must present it. If the reaper decided the lease was dead and
 * gave the job to someone else, the epoch has moved on, the write matches zero
 * rows, and the method returns `false`.
 *
 * A worker that sees `false` has lost the job and **must discard its work
 * without writing anything**. This is not defensive padding: a worker whose
 * event loop was blocked past the lease deadline is alive and holding results,
 * and without the token both it and the new owner would write them.
 *
 * ## Why the claim is one statement
 *
 * `UPDATE ... WHERE id = (SELECT ...) RETURNING *` is atomic on its own. The
 * write transaction opens before the subquery's read, so no two callers can
 * select the same row. Wrapping it in an explicit transaction would *break*
 * this: a deferred transaction that reads before writing must promote, and under
 * WAL that promotion fails with SQLITE_BUSY_SNAPSHOT — a code the busy handler
 * does not retry.
 */
import type { PreparedStatement, SqliteDriver } from '../driver/types.js';
import { BaseRepository, type Timestamp } from './types.js';

export type JobStatus = 'pending' | 'leased' | 'done' | 'failed' | 'skipped' | 'paused';

export const JOB_STATUSES: readonly JobStatus[] = [
  'pending',
  'leased',
  'done',
  'failed',
  'skipped',
  'paused',
];

/** A job row exactly as stored. Snake_case because it is the raw record. */
export interface JobRecord {
  readonly id: number;
  readonly automation_id: string;
  readonly task_key: string;
  readonly params_json: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly scheduled_at: Timestamp;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Timestamp | null;
  readonly lease_epoch: number;
  readonly heartbeat_at: Timestamp | null;
  readonly last_error: string | null;
  readonly last_error_kind: string | null;
  readonly result_count: number;
  readonly first_run_id: string | null;
  readonly last_run_id: string | null;
  readonly created_at: Timestamp;
  readonly updated_at: Timestamp;
  readonly started_at: Timestamp | null;
  readonly finished_at: Timestamp | null;
}

/** A job to enqueue. `taskKey` is the idempotency key. */
export interface JobSpec {
  readonly automationId: string;
  readonly taskKey: string;
  readonly params: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly scheduledAt?: Timestamp;
}

/**
 * Proof of ownership of a job.
 *
 * Hold it for the duration of the work and present it on every write. Treat a
 * `false` return from any fenced method as "this job is no longer mine".
 */
export interface Lease {
  readonly job: JobRecord;
  readonly owner: string;
  /** Fencing token. Must match `jobs.lease_epoch` for a write to land. */
  readonly epoch: number;
  readonly expiresAt: Timestamp;
}

export interface ClaimOptions {
  readonly automationId: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly runId: string;
  readonly now?: Timestamp;
}

export interface EnqueueResult {
  readonly inserted: number;
  readonly skipped: number;
}

export interface FailOptions {
  readonly error: string;
  readonly errorKind?: string;
  /** When to retry. Ignored once attempts have reached `max_attempts`. */
  readonly retryAt?: Timestamp;
  readonly now?: Timestamp;
}

export type JobCounts = Record<JobStatus, number>;

const JOB_COLUMNS = `id, automation_id, task_key, params_json, status, priority,
  attempts, max_attempts, scheduled_at, lease_owner, lease_expires_at, lease_epoch,
  heartbeat_at, last_error, last_error_kind, result_count, first_run_id, last_run_id,
  created_at, updated_at, started_at, finished_at`;

export class JobsRepository extends BaseRepository {
  readonly #claim: PreparedStatement<JobRecord>;
  readonly #enqueue: PreparedStatement;
  readonly #heartbeat: PreparedStatement;
  readonly #complete: PreparedStatement;
  readonly #fail: PreparedStatement;
  readonly #reap: PreparedStatement<{ id: number }>;
  readonly #saveCheckpoint: PreparedStatement;
  readonly #getCheckpoint: PreparedStatement<{ cursor_json: string }>;

  constructor(driver: SqliteDriver) {
    super(driver);

    // Idempotent by construction: re-running `plan` conflicts on
    // (automation_id, task_key) and inserts nothing.
    this.#enqueue = driver.prepare(
      `INSERT INTO jobs (automation_id, task_key, params_json, priority, max_attempts,
                         scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (automation_id, task_key) DO NOTHING`,
    );

    // Deliberately NOT wrapped in a transaction — see the module docstring.
    // Must be invoked with .get(): .run() would discard the RETURNING row and
    // lease a job whose identity we then could not recover.
    this.#claim = driver.prepare<JobRecord>(
      `UPDATE jobs
          SET status           = 'leased',
              lease_owner      = :owner,
              lease_expires_at = :now + :leaseMs,
              lease_epoch      = lease_epoch + 1,
              heartbeat_at     = :now,
              attempts         = attempts + 1,
              started_at       = COALESCE(started_at, :now),
              first_run_id     = COALESCE(first_run_id, :runId),
              last_run_id      = :runId,
              updated_at       = :now
        WHERE id = (
          SELECT id FROM jobs
           WHERE automation_id = :automationId
             AND status        = 'pending'
             AND scheduled_at <= :now
           ORDER BY priority DESC, scheduled_at ASC, id ASC
           LIMIT 1
        )
       RETURNING ${JOB_COLUMNS}`,
    );

    this.#heartbeat = driver.prepare(
      `UPDATE jobs
          SET lease_expires_at = :now + :leaseMs, heartbeat_at = :now, updated_at = :now
        WHERE id = :id AND lease_owner = :owner AND lease_epoch = :epoch AND status = 'leased'`,
    );

    this.#complete = driver.prepare(
      `UPDATE jobs
          SET status = :status, result_count = :resultCount, finished_at = :now,
              updated_at = :now, lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, last_error_kind = NULL
        WHERE id = :id AND lease_owner = :owner AND lease_epoch = :epoch AND status = 'leased'`,
    );

    // `attempts` was already incremented by the claim, so comparing it against
    // max_attempts here decides retry-vs-give-up using the attempt just spent.
    this.#fail = driver.prepare(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              scheduled_at = CASE WHEN attempts >= max_attempts THEN scheduled_at ELSE :retryAt END,
              finished_at  = CASE WHEN attempts >= max_attempts THEN :now ELSE NULL END,
              last_error = :error, last_error_kind = :errorKind, updated_at = :now,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = :id AND lease_owner = :owner AND lease_epoch = :epoch AND status = 'leased'`,
    );

    // Bumping lease_epoch is what invalidates the previous owner's token. A
    // worker that was merely stalled will now fail every write and drop its
    // results, instead of racing the new owner.
    //
    // `scheduled_at` is deliberately left untouched. Setting it to now would
    // sort these jobs behind every untouched job in the queue (the claim orders
    // by scheduled_at ASC), so after a crash the handful of jobs holding real
    // checkpointed progress would wait behind 15,000 fresh ones and resume days
    // later. They were eligible when they were claimed; they stay eligible.
    //
    // The status CASE is what bounds a poison job. `fail()` is not the only way
    // attempts get spent — a worker that is killed never calls it — so without
    // this, a job that reliably kills its worker is reclaimed and re-claimed
    // forever, never reaching 'failed'. Measured before the fix: a job with
    // max_attempts=3 was claimed 10 times in 10 rounds and stayed 'pending'.
    //
    // `last_error` is rewritten rather than left alone, so it cannot keep
    // describing some earlier, unrelated failure beside a 'lease_expired' kind.
    this.#reap = driver.prepare<{ id: number }>(
      `UPDATE jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              lease_owner = NULL, lease_expires_at = NULL,
              lease_epoch = lease_epoch + 1,
              last_error_kind = 'lease_expired',
              last_error = 'worker lease expired without completing the job',
              finished_at = CASE WHEN attempts >= max_attempts THEN :now ELSE finished_at END,
              updated_at = :now
        WHERE status = 'leased' AND lease_expires_at < :now
       RETURNING id`,
    );

    // The fence is inside the statement, via a SELECT that yields no row unless
    // this worker still owns the job. Checking ownership first and then writing
    // would be a check-then-act race: the reaper can reassign the job between
    // the two, and the stale worker's cursor lands on the new owner's job.
    //
    // `INSERT ... SELECT ... WHERE` is the only way to express this, because
    // job_checkpoints carries no lease columns of its own to filter on.
    this.#saveCheckpoint = driver.prepare(
      `INSERT INTO job_checkpoints (job_id, cursor_json, updated_at)
       SELECT :jobId, :cursor, :now
         FROM jobs
        WHERE id = :jobId AND lease_owner = :owner AND lease_epoch = :epoch
          AND status = 'leased'
       ON CONFLICT (job_id) DO UPDATE SET cursor_json = :cursor, updated_at = :now`,
    );

    this.#getCheckpoint = driver.prepare<{ cursor_json: string }>(
      `SELECT cursor_json FROM job_checkpoints WHERE job_id = ?`,
    );
  }

  /**
   * Add jobs, ignoring any whose `(automationId, taskKey)` already exists.
   *
   * Idempotent: running `plan` twice produces the same queue. Wrapped in one
   * transaction so 15,725 inserts are one fsync rather than 15,725.
   */
  enqueue(specs: readonly JobSpec[], now: Timestamp = Date.now()): EnqueueResult {
    if (specs.length === 0) return { inserted: 0, skipped: 0 };

    return this.inTransaction(() => {
      let inserted = 0;
      for (const spec of specs) {
        const result = this.#enqueue.run([
          spec.automationId,
          spec.taskKey,
          JSON.stringify(spec.params ?? {}),
          spec.priority ?? 0,
          spec.maxAttempts ?? 3,
          spec.scheduledAt ?? 0,
          now,
          now,
        ]);
        inserted += result.changes;
      }
      return { inserted, skipped: specs.length - inserted };
    });
  }

  /** Atomically claim the highest-priority ready job, or `null` if none. */
  claim(options: ClaimOptions): Lease | null {
    const now = options.now ?? Date.now();
    // A non-finite lease would compute a NULL lease_expires_at, producing a
    // 'leased' row the reaper's `lease_expires_at < now` can never match — a job
    // stuck forever with no way back. The schema also forbids it; this gives a
    // comprehensible error instead of a constraint violation.
    if (!Number.isFinite(options.leaseMs) || options.leaseMs <= 0) {
      throw new TypeError(`leaseMs must be a positive finite number, got ${options.leaseMs}`);
    }
    const job = this.#claim.get({
      owner: options.owner,
      now,
      leaseMs: options.leaseMs,
      runId: options.runId,
      automationId: options.automationId,
    });

    if (job === undefined) return null;

    return {
      job,
      owner: options.owner,
      epoch: job.lease_epoch,
      expiresAt: now + options.leaseMs,
    };
  }

  /**
   * Extend a lease. Returns `false` if it was lost — stop work immediately.
   *
   * The returned lease carries the new expiry; the epoch is unchanged, since
   * extending an owned lease does not hand it to anyone else.
   */
  heartbeat(lease: Lease, leaseMs: number, now: Timestamp = Date.now()): boolean {
    const result = this.#heartbeat.run({
      id: lease.job.id,
      owner: lease.owner,
      epoch: lease.epoch,
      now,
      leaseMs,
    });
    return result.changes === 1;
  }

  /** Mark a job finished. Returns `false` if the lease was lost. */
  complete(
    lease: Lease,
    resultCount = 0,
    status: 'done' | 'skipped' = 'done',
    now: Timestamp = Date.now(),
  ): boolean {
    const result = this.#complete.run({
      id: lease.job.id,
      owner: lease.owner,
      epoch: lease.epoch,
      status,
      resultCount,
      now,
    });
    return result.changes === 1;
  }

  /**
   * Record a failure. Requeues with backoff, or marks `failed` once attempts are
   * exhausted. Returns `false` if the lease was lost.
   */
  fail(lease: Lease, options: FailOptions): boolean {
    const now = options.now ?? Date.now();
    // Default to a real backoff. Defaulting to `now` would make a failing job
    // instantly re-claimable, so a persistent failure spins at full speed
    // through its whole attempt budget instead of pacing itself.
    const retryAt = options.retryAt ?? now + failureBackoffMs(lease.job.attempts);
    const result = this.#fail.run({
      id: lease.job.id,
      owner: lease.owner,
      epoch: lease.epoch,
      error: truncate(options.error, 2000),
      errorKind: options.errorKind ?? null,
      retryAt,
      now,
    });
    return result.changes === 1;
  }

  /**
   * Return every expired lease to the queue. This is the crash-recovery path:
   * `kill -9`, power loss and VPS reboot all converge here.
   */
  reap(now: Timestamp = Date.now()): number[] {
    return this.#reap.all({ now }).map((row) => row.id);
  }

  /**
   * Persist a resume point. Returns `false` if the lease was lost.
   *
   * Call this inside the same transaction that writes the records it describes.
   * Splitting them is what lets a crash lose the checkpoint while keeping the
   * records, which then get re-scraped and duplicated on resume.
   */
  saveCheckpoint(lease: Lease, cursor: unknown, now: Timestamp = Date.now()): boolean {
    const cursorJson = JSON.stringify(cursor);
    if (cursorJson === undefined) {
      // JSON.stringify(undefined) is undefined, which would bind as NULL and
      // violate NOT NULL with an opaque SqliteError from deep inside a driver.
      throw new TypeError('checkpoint cursor must be JSON-serializable, got undefined');
    }
    const result = this.#saveCheckpoint.run({
      jobId: lease.job.id,
      owner: lease.owner,
      epoch: lease.epoch,
      cursor: cursorJson,
      now,
    });
    return result.changes === 1;
  }

  checkpoint<T = unknown>(jobId: number): T | null {
    const row = this.#getCheckpoint.get([jobId]);
    if (row === undefined) return null;
    return JSON.parse(row.cursor_json) as T;
  }

  /** Whether this lease is still the current owner of its job. */
  ownsLease(lease: Lease): boolean {
    const row = this.driver
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE id = ? AND lease_owner = ? AND lease_epoch = ? AND status = 'leased'`,
      )
      .get([lease.job.id, lease.owner, lease.epoch]);
    return (row?.n ?? 0) === 1;
  }

  byId(id: number): JobRecord | null {
    return (
      this.driver.prepare<JobRecord>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get([id]) ??
      null
    );
  }

  byTaskKey(automationId: string, taskKey: string): JobRecord | null {
    return (
      this.driver
        .prepare<JobRecord>(
          `SELECT ${JOB_COLUMNS} FROM jobs WHERE automation_id = ? AND task_key = ?`,
        )
        .get([automationId, taskKey]) ?? null
    );
  }

  /**
   * Job counts by status, with every status present (zero when absent).
   *
   * Filters on `undefined`, not falsiness: `counts('')` must mean "the
   * automation named empty string", which has no jobs, rather than silently
   * reporting totals for the whole database.
   */
  counts(automationId?: string): JobCounts {
    const rows =
      automationId !== undefined
        ? this.driver
            .prepare<{ status: JobStatus; n: number }>(
              `SELECT status, COUNT(*) AS n FROM jobs WHERE automation_id = ? GROUP BY status`,
            )
            .all([automationId])
        : this.driver
            .prepare<{ status: JobStatus; n: number }>(
              `SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`,
            )
            .all();

    const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as JobCounts;
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  list(
    options: {
      automationId?: string;
      status?: JobStatus;
      errorKind?: string;
      limit?: number;
    } = {},
  ): JobRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.automationId !== undefined) {
      where.push('automation_id = ?');
      params.push(options.automationId);
    }
    if (options.status !== undefined) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.errorKind !== undefined) {
      where.push('last_error_kind = ?');
      params.push(options.errorKind);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(options.limit ?? 50);

    return this.driver
      .prepare<JobRecord>(
        `SELECT ${JOB_COLUMNS} FROM jobs ${clause}
          ORDER BY priority DESC, id ASC LIMIT ?`,
      )
      .all(params);
  }

  /**
   * Return jobs to `pending` for a manual retry.
   *
   * Resets `attempts` so an operator retry is not immediately re-exhausted, and
   * clears the checkpoint so the job genuinely re-runs rather than resuming at
   * the point the failed attempt reached.
   *
   * `lease_epoch` is bumped for every row touched, so if one of them is
   * currently leased its worker is fenced out and cannot complete the job
   * underneath the retry.
   *
   * Selection rules, in order:
   *  - Explicit `ids` select exactly those jobs, in whatever state they are in.
   *    Naming a job is an instruction to retry *that* job.
   *  - An explicit but **empty** `ids` array selects nothing. It must never
   *    widen to "everything" — that would turn a no-op operator command into a
   *    reset of the entire failed backlog.
   *  - With no `ids` and no `status`, the default is the failed/paused backlog.
   *    Live `leased` jobs are deliberately excluded, so a routine retry cannot
   *    yank work away from healthy running workers.
   */
  retry(
    options: { automationId?: string; status?: JobStatus; ids?: readonly number[] } = {},
  ): number {
    // An explicit empty selection means nothing, never everything.
    if (options.ids !== undefined && options.ids.length === 0) return 0;

    // Each id becomes its own bound parameter, and SQLite caps those. Split
    // oversized selections rather than failing with "too many SQL variables".
    if (options.ids !== undefined && options.ids.length > SQL_VARIABLE_LIMIT) {
      let total = 0;
      for (const chunk of chunked(options.ids, SQL_VARIABLE_LIMIT)) {
        total += this.retry({ ...options, ids: chunk });
      }
      return total;
    }

    const now = Date.now();
    const where: string[] = [];
    const params: Record<string, SqlBindable> = { now };

    if (options.ids !== undefined) {
      where.push(`id IN (${options.ids.map((_, i) => `:id${i}`).join(', ')})`);
      options.ids.forEach((id, i) => {
        params[`id${i}`] = id;
      });
    }
    if (options.automationId !== undefined) {
      where.push('automation_id = :automationId');
      params['automationId'] = options.automationId;
    }
    if (options.status !== undefined) {
      where.push('status = :status');
      params['status'] = options.status;
    } else if (options.ids === undefined) {
      where.push("status IN ('failed', 'paused')");
    }

    return this.inTransaction(() => {
      // RETURNING, not a second SELECT: by the time the update commits these
      // rows are 'pending', so re-running the same WHERE would match nothing
      // and the checkpoints would silently survive the retry.
      const updated = this.driver
        .prepare<{ id: number }>(
          `UPDATE jobs
              SET status = 'pending', attempts = 0, scheduled_at = :now,
                  lease_owner = NULL, lease_expires_at = NULL,
                  lease_epoch = lease_epoch + 1,
                  last_error = NULL, last_error_kind = NULL,
                  result_count = 0, finished_at = NULL, updated_at = :now
            WHERE ${where.join(' AND ')}
           RETURNING id`,
        )
        .all(params);

      // Drop resume cursors for everything just reset, so the re-run starts
      // from the beginning instead of the previous attempt's stopping point.
      for (const chunk of chunked(
        updated.map((row) => row.id),
        SQL_VARIABLE_LIMIT,
      )) {
        this.driver
          .prepare(
            `DELETE FROM job_checkpoints WHERE job_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .run(chunk);
      }

      return updated.length;
    });
  }
}

type SqlBindable = string | number | null;

/**
 * Bound parameters per statement.
 *
 * SQLite's own limit is far higher (32,766 since 3.32), but statements are
 * cached by SQL text and a distinct placeholder count produces a distinct
 * statement, so very wide `IN` lists also thrash the cache. 500 is well clear of
 * both problems.
 */
const SQL_VARIABLE_LIMIT = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Truncate to `max` UTF-16 units without splitting a surrogate pair.
 *
 * A plain `slice` can cut an emoji in half and leave a lone surrogate, which
 * SQLite stores as U+FFFD — so the error text an operator reads ends in a
 * replacement character. Error messages routinely carry scraped business names.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  // A high surrogate in the final slot has lost its partner: drop it.
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * Backoff before retrying a failed attempt: exponential, jittered, capped.
 *
 * Jitter matters with several workers: without it, a batch of jobs that failed
 * together — the usual shape, since the cause is usually one upstream problem —
 * all become eligible on the same tick and stampede the same failing resource.
 */
export function failureBackoffMs(
  attempt: number,
  options: {
    baseMs?: number;
    factor?: number;
    maxMs?: number;
    random?: () => number;
  } = {},
): number {
  const base = options.baseMs ?? 1_000;
  const factor = options.factor ?? 2;
  const max = options.maxMs ?? 300_000;
  const random = options.random ?? Math.random;
  const window = Math.min(base * factor ** Math.max(0, attempt - 1), max);
  // Half fixed, half random: never retries instantly, never in lockstep.
  return Math.round(window / 2 + random() * (window / 2));
}
