/**
 * `gms status` and `gms jobs` — inspect and steer the queue.
 *
 * This is the answer to "where is my 15,725-job run right now", which the
 * legacy per-city DONE flag could never give.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import {
  JOB_STATUSES,
  JobsRepository,
  type JobRecord,
  type JobStatus,
} from '../../db/repositories/jobs.js';
import {
  GROUPINGS,
  ProgressRepository,
  type GroupingName,
  type ProgressGroup,
} from '../../db/repositories/progress.js';
import { CategoriesRepository, CitiesRepository } from '../../db/repositories/seeds.js';
import { bar, formatDuration, heading, keyValue, percent, style, symbol } from '../output.js';

export interface StatusOptions {
  readonly config: ResolvedConfig;
  readonly automationId?: string;
  readonly json?: boolean;
  /** Break the queue down by city, category or state instead of totals only. */
  readonly by?: GroupingName;
  /** Hide groups with nothing left to run. */
  readonly incompleteOnly?: boolean;
  readonly limit?: number;
}

const STATUS_STYLE: Record<JobStatus, (s: string) => string> = {
  pending: style.grey,
  leased: style.cyan,
  done: style.green,
  failed: style.red,
  skipped: style.yellow,
  paused: style.yellow,
};

/** Render the per-group breakdown for `status --by city|category|state`. */
function renderGroups(groups: readonly ProgressGroup[], by: GroupingName): void {
  if (groups.length === 0) {
    console.log(style.grey('Nothing to show — no jobs match.'));
    return;
  }

  const labelWidth = Math.min(
    28,
    groups.reduce((max, g) => Math.max(max, g.label.length), 0),
  );
  const complete = groups.filter((g) => g.pending + g.leased + g.failed === 0).length;

  console.log(heading(`Progress by ${by}`));
  for (const g of groups) {
    const fraction = g.total === 0 ? 0 : (g.done + g.skipped) / g.total;
    const label = g.label.length > labelWidth ? `${g.label.slice(0, labelWidth - 1)}…` : g.label;
    const suffix =
      g.sublabel !== null && g.sublabel !== g.label ? style.grey(` ${g.sublabel}`) : '';
    const counts = `${String(g.done).padStart(5)}/${String(g.total).padEnd(5)}`;
    const problems =
      g.failed > 0
        ? style.red(` ${g.failed} failed`)
        : g.leased > 0
          ? style.cyan(` ${g.leased} running`)
          : '';

    console.log(
      `  ${label.padEnd(labelWidth)}${suffix.padEnd(suffix === '' ? 0 : 4)} ` +
        `${bar(fraction)} ${percent(fraction)} ${style.grey(counts)}${problems}`,
    );
  }

  console.log(`\n${style.grey(`${complete} of ${groups.length} ${by}(s) complete`)}`);
}

export function runStatus(options: StatusOptions): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const jobs = new JobsRepository(driver);

    if (options.by !== undefined) {
      const grouping = GROUPINGS[options.by];
      const groups = new ProgressRepository(driver).groups({
        automationId: options.automationId ?? 'google-maps',
        idPath: grouping.idPath,
        labelPath: grouping.labelPath,
        ...('sublabelPath' in grouping && { sublabelPath: grouping.sublabelPath }),
        ...(options.incompleteOnly !== undefined && { incompleteOnly: options.incompleteOnly }),
        ...(options.limit !== undefined && { limit: options.limit }),
      });

      if (options.json === true) {
        console.log(JSON.stringify({ by: options.by, groups }, null, 2));
        return;
      }
      renderGroups(groups, options.by);
      return;
    }
    const counts = jobs.counts(options.automationId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const cities = new CitiesRepository(driver).count();
    const categories = new CategoriesRepository(driver).count();

    // Throughput from jobs finished in the last hour — the only honest basis
    // for an ETA, since early jobs run at a different rate than a warm run.
    const hourAgo = Date.now() - 3_600_000;
    const recent =
      driver
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM jobs WHERE finished_at IS NOT NULL AND finished_at > ?`,
        )
        .get([hourAgo])?.n ?? 0;

    const remaining = counts.pending + counts.leased;
    const etaMs = recent > 0 ? (remaining / recent) * 3_600_000 : null;

    if (options.json === true) {
      console.log(
        JSON.stringify(
          {
            automationId: options.automationId ?? null,
            seeds: { cities, categories },
            jobs: counts,
            total,
            jobsPerHour: recent,
            remaining,
            etaMs,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      keyValue([
        ['automation', options.automationId ?? 'all'],
        ['seeds', `${cities.toLocaleString()} cities x ${categories.toLocaleString()} categories`],
        ['jobs', total.toLocaleString()],
      ]),
    );

    if (total === 0) {
      console.log(`\n${style.grey('No jobs yet. Create them with:  gms plan')}`);
      return;
    }

    console.log(heading('Queue'));
    for (const status of JOB_STATUSES) {
      const n = counts[status];
      if (n === 0 && status !== 'pending' && status !== 'done') continue;
      const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
      console.log(
        `  ${STATUS_STYLE[status](status.padEnd(9))} ${n.toLocaleString().padStart(9)}  ${style.grey(`${pct}%`)}`,
      );
    }

    if (recent > 0) {
      console.log(heading('Throughput'));
      console.log(
        keyValue([
          ['last hour', `${recent.toLocaleString()} jobs`],
          ['remaining', remaining.toLocaleString()],
          ['eta', etaMs === null ? 'unknown' : formatDuration(etaMs)],
        ]),
      );
    }

    if (counts.failed > 0) {
      console.log(
        `\n${symbol.warn} ${counts.failed} failed. Inspect with:  gms jobs list --status failed`,
      );
    }
  } finally {
    driver.close();
  }
}

export interface JobsListOptions {
  readonly config: ResolvedConfig;
  readonly automationId?: string;
  readonly status?: JobStatus;
  readonly errorKind?: string;
  readonly limit?: number;
  readonly json?: boolean;
}

export function runJobsList(options: JobsListOptions): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const rows = new JobsRepository(driver).list({
      ...(options.automationId !== undefined && { automationId: options.automationId }),
      ...(options.status !== undefined && { status: options.status }),
      ...(options.errorKind !== undefined && { errorKind: options.errorKind }),
      ...(options.limit !== undefined && { limit: options.limit }),
    });

    if (options.json === true) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(style.grey('No matching jobs.'));
      return;
    }

    console.log(
      style.bold(
        `  ${'id'.padStart(7)}  ${'status'.padEnd(9)} ${'pri'.padStart(4)} ${'try'.padStart(4)}  task`,
      ),
    );
    for (const job of rows) {
      console.log(
        `  ${String(job.id).padStart(7)}  ${STATUS_STYLE[job.status](job.status.padEnd(9))} ` +
          `${String(job.priority).padStart(4)} ${`${job.attempts}/${job.max_attempts}`.padStart(4)}  ` +
          `${describeTask(job)}`,
      );
      if (job.last_error !== null) {
        console.log(`  ${' '.repeat(7)}  ${style.red(job.last_error.slice(0, 100))}`);
      }
    }
  } finally {
    driver.close();
  }
}

/** Human-readable job label, falling back to the raw task key. */
function describeTask(job: JobRecord): string {
  try {
    const params = JSON.parse(job.params_json) as Record<string, unknown>;
    const city = params['city'];
    const stateCode = params['stateCode'];
    const category = params['category'];
    if (typeof city === 'string' && typeof category === 'string') {
      return `${category} in ${city}${typeof stateCode === 'string' ? `, ${stateCode}` : ''}`;
    }
  } catch {
    // Fall through to the task key.
  }
  return job.task_key;
}

export interface JobsRetryOptions {
  readonly config: ResolvedConfig;
  readonly automationId?: string;
  readonly status?: JobStatus;
  readonly ids?: readonly number[];
}

export function runJobsRetry(options: JobsRetryOptions): void {
  const driver = openDatabaseFromConfig(options.config);
  try {
    const n = new JobsRepository(driver).retry({
      ...(options.automationId !== undefined && { automationId: options.automationId }),
      ...(options.status !== undefined && { status: options.status }),
      ...(options.ids !== undefined && { ids: options.ids }),
    });
    console.log(
      n === 0
        ? style.grey('No jobs matched — nothing to retry.')
        : `${symbol.ok} ${n} job(s) returned to pending`,
    );
  } finally {
    driver.close();
  }
}
