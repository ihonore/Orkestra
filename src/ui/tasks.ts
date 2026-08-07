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
import { fileURLToPath } from 'node:url';

export type TaskName = 'run' | 'enrich' | 'export' | 'import-cities' | 'import-categories' | 'plan';

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
 * Supervises one task at a time per name.
 *
 * Two concurrent `run` processes would contend for the same job queue — which
 * the leasing makes *safe*, but which is almost never what someone clicking a
 * button intends, so it is refused rather than silently allowed.
 */
export class TaskManager {
  readonly #tasks = new Map<string, Task>();
  readonly #children = new Map<string, ChildProcess>();

  constructor(
    private readonly options: {
      readonly cliEntry: string;
      readonly cwd: string;
      readonly configFile?: string;
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
      this.#children.delete(id);
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
      this.#children.delete(id);
    });

    return { ok: true, task };
  }

  /**
   * Ask a task to stop.
   *
   * SIGTERM, not SIGKILL: the engine installs a handler that finishes in-flight
   * jobs, checkpoints them, and closes the browser. Killing outright would
   * orphan Chromium and leave leases held until the reaper expires them.
   */
  stop(id: string): boolean {
    const child = this.#children.get(id);
    const task = this.#tasks.get(id);
    if (child === undefined || task === undefined) return false;

    task.state = 'stopped';
    task.lines.push('— stopping: finishing in-flight work —');
    child.kill('SIGTERM');
    return true;
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

  // src/ui/tasks.ts -> ../../node_modules/tsx/dist/cli.mjs
  const here = fileURLToPath(import.meta.url);
  const tsx = path.resolve(
    path.dirname(here),
    '..',
    '..',
    'node_modules',
    'tsx',
    'dist',
    'cli.mjs',
  );
  if (!fs.existsSync(tsx)) {
    throw new Error(`cannot run a TypeScript entry without tsx (looked in ${tsx})`);
  }
  return [tsx];
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
