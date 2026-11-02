/**
 * Autopilot: the whole pipeline, unattended.
 *
 * Scraping, finding emails and sending to the sheet used to be three buttons
 * someone had to press at the right moments. Emails can only be found for
 * websites already scraped, and the sheet is only worth updating once there
 * are new addresses — so the right moments are knowable, and this decides
 * them:
 *
 *  - **Scrape** whenever searches are queued.
 *  - **Find emails** once enough websites are waiting, alongside the scrape.
 *    A crawl is plain HTTP, light enough to share the machine with browsers.
 *  - **Send to the sheet** in batches: when enough new leads with an email
 *    have built up, or when the oldest has waited long enough, or when
 *    everything else is finished. Leads without an email are left out by
 *    default, because the sheet is for email outreach and including them
 *    means a blank row now and a duplicate row later.
 *
 * Every step runs as the same child process its button would start, through
 * the same allow-list. Autopilot adds no second way of doing anything; it only
 * presses the buttons. The decision is a pure function ({@link decide}), so it
 * can be tested without time, browsers or Google.
 *
 * Load is bounded in three ways: worker counts are hard ceilings, a new step
 * never starts while free memory is below the configured floor, and a step
 * that fails waits with growing backoff instead of being restarted in a loop.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { Logger } from '../core/logging/logger.js';
import type { Task, TaskManager, TaskName } from './tasks.js';

export interface AutopilotSettings {
  readonly enabled: boolean;
  readonly scrape: { readonly enabled: boolean; readonly workers: number };
  readonly emails: {
    readonly enabled: boolean;
    readonly workers: number;
    /** Start a crawl once this many websites are waiting. */
    readonly minSites: number;
  };
  readonly sheets: {
    readonly enabled: boolean;
    /** Send once this many new rows are ready... */
    readonly batchRows: number;
    /** ...or once the oldest unsent row has waited this long. */
    readonly maxWaitMinutes: number;
  };
  /** Start nothing new while free memory is below this. */
  readonly minFreeMemoryMb: number;
}

/**
 * Defaults sized for the production VPS: 7 GB usable, Windows taking ~2 GB,
 * each scrape worker a Chromium of 400-700 MB on Maps. Four of those leave
 * headroom; the crawl is HTTP-only and cheap. One residential IP is the
 * binding constraint long before the hardware is, so these favour steady
 * over fast.
 */
export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  enabled: false,
  scrape: { enabled: true, workers: 4 },
  emails: { enabled: true, workers: 8, minSites: 25 },
  sheets: { enabled: true, batchRows: 500, maxWaitMinutes: 120 },
  minFreeMemoryMb: 1024,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

type Loose = Record<string, unknown>;
const section = (value: unknown): Loose =>
  typeof value === 'object' && value !== null ? (value as Loose) : {};

/**
 * Coerce anything — a form, a stored value from an older version — into valid
 * settings. Values are clamped, not rejected, like the task buttons'.
 */
export function normalizeAutopilot(input: unknown): AutopilotSettings {
  const d = DEFAULT_AUTOPILOT;
  const raw = section(input);
  const scrape = section(raw['scrape']);
  const emails = section(raw['emails']);
  const sheets = section(raw['sheets']);
  return {
    enabled: flag(raw['enabled'], d.enabled),
    scrape: {
      enabled: flag(scrape['enabled'], d.scrape.enabled),
      // 8 is adaptive concurrency's ceiling; more workers would only park.
      workers: clamp(scrape['workers'], 1, 8, d.scrape.workers),
    },
    emails: {
      enabled: flag(emails['enabled'], d.emails.enabled),
      workers: clamp(emails['workers'], 1, 32, d.emails.workers),
      minSites: clamp(emails['minSites'], 1, 10_000, d.emails.minSites),
    },
    sheets: {
      enabled: flag(sheets['enabled'], d.sheets.enabled),
      // Below 50 a batch is mostly overhead against the 60-writes/min quota;
      // above 10,000 it stops being a batch.
      batchRows: clamp(sheets['batchRows'], 50, 10_000, d.sheets.batchRows),
      maxWaitMinutes: clamp(sheets['maxWaitMinutes'], 10, 1_440, d.sheets.maxWaitMinutes),
    },
    minFreeMemoryMb: clamp(raw['minFreeMemoryMb'], 256, 65_536, d.minFreeMemoryMb),
  };
}

/** What the database says, read fresh on every tick. */
export interface Snapshot {
  /** Searches a worker could claim. */
  readonly searchesQueued: number;
  /** Websites waiting to be crawled. */
  readonly sitesQueued: number;
  /** Rows the sheet export would send; null when Sheets is not set up. */
  readonly rowsUnsent: number | null;
  /**
   * What to send, from the sheet's layout setting (step 7): one view, so a
   * manual send and an automatic one always agree.
   */
  readonly sheetEntity: string;
  /** When the sheet last received rows, if ever. */
  readonly lastSentAt: number | null;
  /** A re-scrape in progress, which holds the sheet back until it finishes. */
  readonly rescrape: { readonly total: number; readonly remaining: number } | null;
}

/** One of the three stages, which map one-to-one onto task names. */
export type Stage = 'scrape' | 'emails' | 'sheets';
export const STAGE_TASK: Record<Stage, TaskName> = {
  scrape: 'run',
  emails: 'enrich',
  sheets: 'export-sheets',
};

/** When a stage may next start, after a failure or a finished run. */
export interface StageHistory {
  readonly failures: number;
  readonly notBefore: number;
}

export interface StageStatus {
  readonly state: 'off' | 'running' | 'waiting' | 'idle' | 'blocked';
  readonly detail: string;
}

export interface Decision {
  readonly start: { stage: Stage; input: Record<string, unknown> }[];
  readonly status: Record<Stage, StageStatus>;
}

export interface DecideInput {
  readonly settings: AutopilotSettings;
  readonly snapshot: Snapshot;
  readonly running: ReadonlySet<TaskName>;
  readonly history: Readonly<Record<Stage, StageHistory>>;
  readonly now: number;
  readonly freeMemoryMb: number;
  /** When autopilot was turned on; the sheet's wait is measured from here at first. */
  readonly enabledAt: number;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** Decide what to start now, and describe every stage. Pure. */
export function decide(input: DecideInput): Decision {
  const { settings, snapshot, running, history, now } = input;
  const start: Decision['start'] = [];
  const memoryOk = input.freeMemoryMb >= settings.minFreeMemoryMb;
  const lowMemory = `waiting: ${Math.round(input.freeMemoryMb)} MB free, below the ${settings.minFreeMemoryMb} MB floor`;

  // Shared gate: off, already running, backing off, or short of memory.
  const gate = (stage: Stage, enabled: boolean): StageStatus | null => {
    if (!settings.enabled || !enabled) return { state: 'off', detail: 'off' };
    if (running.has(STAGE_TASK[stage])) return { state: 'running', detail: 'running' };
    const wait = history[stage].notBefore - now;
    if (wait > 0) {
      return history[stage].failures > 0
        ? { state: 'blocked', detail: `last run failed; retrying in ${minutes(wait)}` }
        : { state: 'waiting', detail: `starting again in ${minutes(wait)}` };
    }
    return null;
  };

  // ── Scrape ──
  let scrape = gate('scrape', settings.scrape.enabled);
  if (scrape === null) {
    if (snapshot.searchesQueued === 0) scrape = { state: 'idle', detail: 'no searches queued' };
    else if (!memoryOk) scrape = { state: 'waiting', detail: lowMemory };
    else {
      start.push({ stage: 'scrape', input: { workers: settings.scrape.workers } });
      scrape = { state: 'running', detail: 'starting' };
    }
  } else if (scrape.state === 'running') {
    scrape = {
      state: 'running',
      detail: `${settings.scrape.workers} workers · ${snapshot.searchesQueued.toLocaleString()} searches to go`,
    };
  }
  const scraping = scrape.state === 'running';

  // ── Emails ──
  let emails = gate('emails', settings.emails.enabled);
  if (emails === null) {
    // Once nothing more is coming, a short queue is worth crawling too.
    const enough =
      snapshot.sitesQueued >= settings.emails.minSites ||
      (snapshot.sitesQueued > 0 && !scraping && snapshot.searchesQueued === 0);
    if (snapshot.sitesQueued === 0) emails = { state: 'idle', detail: 'no websites waiting' };
    else if (!enough) {
      emails = {
        state: 'waiting',
        detail: `${snapshot.sitesQueued} of ${settings.emails.minSites} websites waiting`,
      };
    } else if (!memoryOk) emails = { state: 'waiting', detail: lowMemory };
    else {
      start.push({ stage: 'emails', input: { workers: settings.emails.workers } });
      emails = { state: 'running', detail: 'starting' };
    }
  } else if (emails.state === 'running') {
    emails = {
      state: 'running',
      detail: `${settings.emails.workers} workers · ${snapshot.sitesQueued.toLocaleString()} websites to go`,
    };
  }

  // ── Sheets ──
  let sheets = gate('sheets', settings.sheets.enabled);
  if (sheets === null) {
    const unsent = snapshot.rowsUnsent;
    const kind =
      snapshot.sheetEntity === 'leads-by-business'
        ? 'businesses with an email'
        : snapshot.sheetEntity === 'leads-with-email'
          ? 'leads with an email'
          : 'rows';
    if (unsent === null) {
      sheets = { state: 'blocked', detail: 'not set up: add the sheet and key in step 7' };
    } else if (snapshot.rescrape !== null) {
      // Sending now would ship the very data the re-scrape is correcting.
      const { total, remaining } = snapshot.rescrape;
      sheets = {
        state: 'waiting',
        detail:
          `holding until the re-scrape finishes: ${(total - remaining).toLocaleString()} of ` +
          `${total.toLocaleString()} searches re-read`,
      };
    } else if (unsent === 0) {
      sheets = { state: 'idle', detail: 'the sheet is up to date' };
    } else {
      const since = snapshot.lastSentAt ?? input.enabledAt;
      const due = since + settings.sheets.maxWaitMinutes * 60_000;
      const pipelineDone =
        !scraping &&
        !running.has('enrich') &&
        snapshot.searchesQueued === 0 &&
        snapshot.sitesQueued === 0;
      if (unsent >= settings.sheets.batchRows || now >= due || pipelineDone) {
        start.push({ stage: 'sheets', input: { entity: snapshot.sheetEntity } });
        sheets = { state: 'running', detail: `sending ${unsent.toLocaleString()} ${kind}` };
      } else {
        sheets = {
          state: 'waiting',
          detail:
            `${unsent.toLocaleString()} of ${settings.sheets.batchRows.toLocaleString()} ${kind} ready` +
            ` · sending by ${new Date(due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` +
            ` at the latest`,
        };
      }
    }
  }

  return { start, status: { scrape, emails, sheets } };
}

/**
 * Backoff after a stage's run ends: none-ish after success, doubling after
 * each consecutive failure, capped at an hour. A scrape that "succeeds" with
 * searches still queued (all of them in retry backoff) would otherwise be
 * relaunched every tick.
 */
export function afterRun(
  previous: StageHistory,
  succeeded: boolean,
  finishedAt: number,
  stage: Stage,
): StageHistory {
  if (succeeded) {
    const cooldown = stage === 'scrape' ? 2 * 60_000 : stage === 'emails' ? 60_000 : 0;
    return { failures: 0, notBefore: finishedAt + cooldown };
  }
  const failures = previous.failures + 1;
  const backoff = Math.min(60 * 60_000, 2 * 60_000 * 2 ** (failures - 1));
  return { failures, notBefore: finishedAt + backoff };
}

export const FRESH_HISTORY: Readonly<Record<Stage, StageHistory>> = {
  scrape: { failures: 0, notBefore: 0 },
  emails: { failures: 0, notBefore: 0 },
  sheets: { failures: 0, notBefore: 0 },
};

/**
 * Memory that could be given to a new process, in MB.
 *
 * `os.freemem()` is right on Windows and Linux, where it reports available
 * memory. On macOS it reports only pages that are completely unused, which
 * excludes the file cache the system frees on demand — measured at 64 MB free
 * on a 16 GB Mac with gigabytes to spare — so the guard would never let
 * anything start. There, free + inactive + speculative pages is the honest
 * figure.
 */
export function availableMemoryMb(): number {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 2_000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label: string): number =>
        Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      return ((pages('free') + pages('inactive') + pages('speculative')) * pageSize) / 1_048_576;
    } catch {
      // Fall through to the conservative figure.
    }
  }
  return os.freemem() / 1_048_576;
}

export interface AutopilotDeps {
  readonly load: () => AutopilotSettings;
  readonly save: (settings: AutopilotSettings) => void;
  readonly snapshot: (settings: AutopilotSettings) => Snapshot;
  readonly tasks: TaskManager;
  /** Start a task through the dashboard's allow-list, exactly as its button would. */
  readonly start: (
    name: TaskName,
    input: Record<string, unknown>,
  ) => { ok: true; task: Task } | { ok: false; error: string };
  readonly freeMemoryMb?: () => number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly intervalMs?: number;
}

export interface AutopilotView {
  readonly settings: AutopilotSettings;
  readonly status: Record<Stage, StageStatus>;
  readonly memory: { readonly freeMb: number; readonly totalMb: number };
  /** Why autopilot last turned itself off, if it did. */
  readonly note: string | null;
}

const OFF: Record<Stage, StageStatus> = {
  scrape: { state: 'off', detail: 'off' },
  emails: { state: 'off', detail: 'off' },
  sheets: { state: 'off', detail: 'off' },
};

/** Runs {@link decide} on a timer and starts what it says. */
export class Autopilot {
  #settings: AutopilotSettings;
  #history: Record<Stage, StageHistory> = { ...FRESH_HISTORY };
  /** Tasks this autopilot started, so their outcome feeds the backoff. */
  readonly #watching = new Map<Stage, string>();
  #enabledAt: number;
  #status: Record<Stage, StageStatus> = OFF;
  #note: string | null = null;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AutopilotDeps) {
    this.#settings = deps.load();
    this.#enabledAt = this.#now();
  }

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Start ticking. Resumes straight away if it was left on, e.g. across a reboot. */
  begin(): void {
    this.tick();
    this.#timer = setInterval(() => this.tick(), this.deps.intervalMs ?? 20_000);
    this.#timer.unref();
  }

  end(): void {
    clearInterval(this.#timer);
  }

  update(input: unknown): AutopilotView {
    const next = normalizeAutopilot(input);
    if (next.enabled && !this.#settings.enabled) {
      // A fresh start: forget old failures, and measure the sheet's wait from now.
      this.#enabledAt = this.#now();
      this.#history = { ...FRESH_HISTORY };
      this.#note = null;
    }
    this.#settings = next;
    this.deps.save(next);
    this.tick();
    return this.view();
  }

  /**
   * Turn off because someone stopped a task by hand. Restarting it 20 seconds
   * later would make the Stop button look broken.
   */
  standDown(reason: string): void {
    if (!this.#settings.enabled) return;
    this.#settings = { ...this.#settings, enabled: false };
    this.deps.save(this.#settings);
    this.#note = reason;
    this.#status = OFF;
  }

  tick(): void {
    const now = this.#now();
    for (const [stage, id] of this.#watching) {
      const task = this.deps.tasks.get(id);
      if (task === undefined || task.state === 'running') continue;
      this.#history[stage] = afterRun(
        this.#history[stage],
        task.state === 'succeeded',
        task.finishedAt ?? now,
        stage,
      );
      this.#watching.delete(stage);
    }

    if (!this.#settings.enabled) {
      this.#status = OFF;
      return;
    }

    let snapshot: Snapshot;
    try {
      snapshot = this.deps.snapshot(this.#settings);
    } catch (error) {
      // A busy or briefly locked database is not a reason to stop; try next tick.
      this.deps.logger?.warn({ err: String(error) }, 'autopilot could not read the database');
      return;
    }

    const running = new Set(
      this.deps.tasks
        .list()
        .filter((t) => t.state === 'running')
        .map((t) => t.name),
    );
    const decision = decide({
      settings: this.#settings,
      snapshot,
      running,
      history: this.#history,
      now,
      freeMemoryMb: (this.deps.freeMemoryMb ?? availableMemoryMb)(),
      enabledAt: this.#enabledAt,
    });

    for (const { stage, input } of decision.start) {
      const started = this.deps.start(STAGE_TASK[stage], input);
      if (started.ok) {
        this.#watching.set(stage, started.task.id);
        this.deps.logger?.info({ stage, input }, 'autopilot started a step');
      } else {
        this.deps.logger?.warn({ stage, error: started.error }, 'autopilot could not start a step');
      }
    }
    this.#status = decision.status;
  }

  view(): AutopilotView {
    return {
      settings: this.#settings,
      status: this.#status,
      memory: {
        freeMb: Math.round((this.deps.freeMemoryMb ?? availableMemoryMb)()),
        totalMb: Math.round(os.totalmem() / 1_048_576),
      },
      note: this.#note,
    };
  }
}
