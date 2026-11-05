/**
 * Running CLI commands on behalf of the dashboard.
 *
 * Commands run as **child processes**, not in-process, for three reasons that
 * all matter here:
 *
 *  1. A scrape holds a browser and makes synchronous database calls. Running it
 *     inside the server would freeze the page it is meant to be reporting to.
 *  2. A crash in the scraper must not take down the dashboard.
 *  3. It is the *same* code path the CLI uses, so the button and the command
 *     cannot drift apart. There is no second implementation to keep in sync.
 *
 * The child's runtime is chosen from the entry's file extension, so the same
 * code works under `tsx` in development, from `dist` in production, and under a
 * test runner whose own loader flags are unrelated.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STOP_MESSAGE } from '../core/engine/shutdown.js';

export type TaskName =
  'run' | 'enrich' | 'export' | 'export-sheets' | 'import-cities' | 'import-categories' | 'plan';

export type TaskState = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface Task {
  readonly id: string;
  readonly name: TaskName;
  readonly label: string;
  readonly args: readonly string[];
  state: TaskState;
  readonly startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** Rolling tail of output. Bounded so a week-long run cannot exhaust memory. */
  readonly lines: string[];
}

export interface StartRequest {
  readonly name: TaskName;
  readonly args: readonly string[];
  readonly label: string;
}

const MAX_LINES = 500;

/**
 * Finished tasks kept for the Activity panel. Autopilot starts one every few
 * hours for weeks; each keeps up to MAX_LINES of output, so without a bound the
 * dashboard's memory would grow for as long as it runs.
 */
const MAX_FINISHED = 40;

/**
 * The one line that says why a task failed, read from its output.
 *
 * The CLI reports a failure as `✗ message` (`XX message` on consoles without
 * Unicode), followed by a hint. The last such line is the reason; a message
 * ending in a colon has its detail on the next line. Without one, the output's
 * last line is the best evidence there is.
 */
export function failureReason(lines: readonly string[]): string | null {
  // eslint-disable-next-line no-control-regex -- matching colour codes is the point
  const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim());
  for (let i = plain.length - 1; i >= 0; i -= 1) {
    const reported = /^(?:✗|XX) (.+)$/.exec(plain[i]!)?.[1];
    if (reported === undefined) continue;
    const next = plain[i + 1];
    const text = reported.endsWith(':') && next !== undefined ? `${reported} ${next}` : reported;
    return text.slice(0, 300);
  }
  return plain.at(-1)?.slice(0, 300) ?? null;
}

/**
 * Supervises one task at a time per name.
 *
 * Two concurrent `run` processes would contend for the same job queue — which
 * the leasing makes *safe*, but which is almost never what someone clicking a
 * button intends, so it is refused rather than silently allowed.
 */
export class TaskManager {
  readonly #tasks = new Map<string, Task>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #killTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly options: {
      readonly cliEntry: string;
      readonly cwd: string;
      readonly configFile?: string;
      /**
       * How long a stopped task may take to exit before it is killed. Should
       * exceed the child's own shutdown grace, or a clean stop gets cut short.
       */
      readonly stopTimeoutMs?: number;
    },
  ) {}

  list(): Task[] {
    return [...this.#tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  isRunning(name: TaskName): boolean {
    return [...this.#tasks.values()].some((t) => t.name === name && t.state === 'running');
  }

  /** The task currently running, if any. Used to disable the right buttons. */
  running(): Task | undefined {
    return [...this.#tasks.values()].find((t) => t.state === 'running');
  }

  start(request: StartRequest): { ok: true; task: Task } | { ok: false; error: string } {
    if (this.isRunning(request.name)) {
      return { ok: false, error: `${request.label} is already running` };
    }

    this.#prune();
    const id = randomBytes(6).toString('hex');
    const args = [...runtimeArgsFor(this.options.cliEntry), this.options.cliEntry];
    if (this.options.configFile !== undefined) args.push('--config', this.options.configFile);
    args.push(...request.args);

    const task: Task = {
      id,
      name: request.name,
      label: request.label,
      args: request.args,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      lines: [],
    };
    this.#tasks.set(id, task);

    const child = spawn(process.execPath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        // The child writes NDJSON to its log file regardless; forcing plain
        // console output keeps the panel readable rather than a wall of JSON.
        GMS_LOGGING__PRETTY: 'false',
        NO_COLOR: '1',
      },
      // The IPC channel is how a stop is requested; see stop().
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#children.set(id, child);

    const append = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed === '') continue;
        task.lines.push(trimmed);
        if (task.lines.length > MAX_LINES) task.lines.shift();
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      task.lines.push(`failed to start: ${error.message}`);
      task.state = 'failed';
      task.finishedAt = Date.now();
      this.#forget(id);
    });

    child.on('close', (code, signal) => {
      task.exitCode = code;
      task.finishedAt = Date.now();
      // A task we asked to stop is not a failure.
      task.state =
        task.state === 'stopped' || signal === 'SIGTERM'
          ? 'stopped'
          : code === 0
            ? 'succeeded'
            : 'failed';
      this.#forget(id);
    });

    return { ok: true, task };
  }

  /**
   * Ask a task to stop.
   *
   * By message over the IPC channel, not by signal. The child's handler
   * finishes in-flight jobs, checkpoints them and closes the browser; killing
   * outright would orphan Chromium and leave leases held until the reaper
   * expires them. A signal used to do this, but on Windows `kill()` is
   * TerminateProcess whatever signal is named, so the graceful path never ran.
   *
   * Only if the child is still alive after `stopTimeoutMs` is it killed.
   */
  stop(id: string): boolean {
    const child = this.#children.get(id);
    const task = this.#tasks.get(id);
    if (child === undefined || task === undefined || task.state === 'stopped') return false;

    task.state = 'stopped';
    task.lines.push('— stopping: finishing in-flight work —');
    if (child.connected) child.send(STOP_MESSAGE);
    else child.kill('SIGTERM');

    const timer = setTimeout(() => {
      task.lines.push('— did not stop in time: killed —');
      child.kill('SIGKILL');
    }, this.options.stopTimeoutMs ?? 60_000);
    // A pending kill must not keep the dashboard process alive on its own.
    timer.unref();
    this.#killTimers.set(id, timer);
    return true;
  }

  /** Drop the oldest finished tasks beyond {@link MAX_FINISHED}. */
  #prune(): void {
    const finished = this.list().filter((t) => t.state !== 'running');
    for (const task of finished.slice(MAX_FINISHED)) this.#tasks.delete(task.id);
  }

  #forget(id: string): void {
    this.#children.delete(id);
    clearTimeout(this.#killTimers.get(id));
    this.#killTimers.delete(id);
  }

  /** Stop everything. Called when the dashboard itself shuts down. */
  stopAll(): void {
    for (const id of this.#children.keys()) this.stop(id);
  }
}

/**
 * Node arguments needed to execute `entry`.
 *
 * Chosen from the entry's *extension*, not from `process.execArgv`. Inheriting
 * execArgv looks right and works in development, but breaks under a test runner
 * whose own execArgv has no TypeScript loader — the child then cannot parse a
 * `.ts` file and exits immediately. A compiled `.js` entry needs no loader at
 * all, so this returns nothing for it.
 */
function runtimeArgsFor(entry: string): string[] {
  if (!entry.endsWith('.ts')) return [];

  // tsx's loader, registered with --import, rather than its CLI: the CLI runs
  // the script in a *second* process, which the IPC channel does not reach, so
  // a stop request would never arrive. One process, one channel.
  // src/ui/tasks.ts -> ../../node_modules/tsx/dist/loader.mjs
  const here = fileURLToPath(import.meta.url);
  const loader = path.resolve(
    path.dirname(here),
    '..',
    '..',
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  );
  if (!fs.existsSync(loader)) {
    throw new Error(`cannot run a TypeScript entry without tsx (looked in ${loader})`);
  }
  // A file URL, because --import takes a specifier and a Windows path is not one.
  return ['--import', pathToFileURL(loader).href];
}

/**
 * Locate the CLI entry point for respawning.
 *
 * Resolved relative to *this module*, not `process.argv[1]`. argv[1] is
 * whatever happens to be running — under a test runner it is the runner itself,
 * so the child would be handed `export csv` and fail. Resolving from
 * `import.meta.url` gives the right file however the server was started, and
 * picks up the correct extension automatically: `src/ui/tasks.ts` sits beside
 * `src/cli/main.ts`, and `dist/ui/tasks.js` beside `dist/cli/main.js`.
 */
export function cliEntryPoint(): string {
  const here = fileURLToPath(import.meta.url);
  const extension = here.endsWith('.ts') ? '.ts' : '.js';
  const entry = path.resolve(path.dirname(here), '..', 'cli', `main${extension}`);

  if (!fs.existsSync(entry)) {
    throw new Error(`cannot find the CLI entry point at ${entry}`);
  }
  return entry;
}
