/**
 * Graceful shutdown.
 *
 * A run holds a browser process tree, leased jobs, and unflushed exports. Dying
 * abruptly orphans all three: Chromium keeps running, leases stay held until the
 * reaper expires them, and partial work is lost.
 *
 * ## Why SIGBREAK is listed explicitly
 *
 * Playwright's launcher registers handlers for `exit`, `SIGINT`, `SIGTERM` and
 * `SIGHUP` — but **not** `SIGBREAK`, which is what Ctrl+Break sends on Windows.
 * Without our own handler the default action terminates Node immediately and the
 * entire Chromium tree is orphaned, holding memory and its user-data directory
 * until someone notices. On a Windows VPS that is the difference between a clean
 * restart and a reboot.
 *
 * ## Limits worth stating
 *
 * `taskkill /F` and SIGKILL cannot be intercepted by any process, so orphans
 * remain possible. A hard guarantee would need a Windows Job Object, which plain
 * Node cannot create. The mitigation is the startup sweep in
 * {@link sweepOrphanedBrowsers}, not a promise that it never happens.
 */
import type { Logger } from '../logging/logger.js';

export type ShutdownReason = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK' | 'manual';

export interface ShutdownOptions {
  /** How long in-flight work may take to finish before it is abandoned. */
  readonly graceSeconds?: number;
  readonly logger?: Logger;
  /** Injectable for tests, so they need not really exit the process. */
  readonly exit?: (code: number) => void;
}

type Task = () => Promise<void> | void;

/**
 * Coordinates a clean stop.
 *
 * Callers check {@link signal} to stop taking new work, and register cleanup
 * with {@link onShutdown}. A second signal escalates to an immediate exit,
 * because someone pressing Ctrl-C twice means it.
 */
export class ShutdownController {
  readonly #controller = new AbortController();
  readonly #tasks: { name: string; task: Task }[] = [];
  readonly #handlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
  #shuttingDown = false;
  #completed = false;

  constructor(private readonly options: ShutdownOptions = {}) {}

  /** Aborts when shutdown begins. Pass into work that should stop early. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Register cleanup. Tasks run in reverse registration order, like a stack. */
  onShutdown(name: string, task: Task): void {
    this.#tasks.push({ name, task });
  }

  /**
   * Install signal handlers.
   *
   * SIGBREAK is included for Windows. Registering it on POSIX is harmless —
   * Node accepts the name and the signal simply never arrives.
   */
  install(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
    for (const sig of signals) {
      const handler = (): void => {
        void this.shutdown(sig as ShutdownReason);
      };
      try {
        process.on(sig, handler);
        this.#handlers.push({ signal: sig, handler });
      } catch {
        // A platform that does not know this signal name. Nothing to do.
      }
    }
  }

  /** Remove handlers, so a long-lived process (or a test) is not left leaking them. */
  uninstall(): void {
    for (const { signal, handler } of this.#handlers) process.off(signal, handler);
    this.#handlers.length = 0;
  }

  /**
   * Begin shutdown, running cleanup within the grace period.
   *
   * A second call escalates: cleanup is abandoned and the process exits.
   */
  async shutdown(reason: ShutdownReason = 'manual'): Promise<void> {
    if (this.#shuttingDown) {
      this.options.logger?.warn({ reason }, 'second shutdown signal — exiting immediately');
      (this.options.exit ?? process.exit.bind(process))(130);
      return;
    }

    this.#shuttingDown = true;
    this.#controller.abort();
    const graceMs = (this.options.graceSeconds ?? 30) * 1000;
    this.options.logger?.info(
      { reason, graceSeconds: graceMs / 1000 },
      'shutting down — finishing in-flight work',
    );

    // Cleanup races the grace period as a whole rather than per task, so one
    // slow task cannot consume everyone else's budget.
    const cleanup = (async () => {
      for (const { name, task } of [...this.#tasks].reverse()) {
        try {
          await task();
          this.options.logger?.debug({ task: name }, 'shutdown task complete');
        } catch (error) {
          this.options.logger?.error({ task: name, err: String(error) }, 'shutdown task failed');
        }
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceMs);
      // Do not hold the event loop open just for the deadline.
      timer.unref?.();
    });

    const outcome = await Promise.race([cleanup.then(() => 'done' as const), deadline]);
    if (timer !== undefined) clearTimeout(timer);

    this.#completed = true;
    if (outcome === 'timeout') {
      this.options.logger?.warn('grace period expired — some work was abandoned');
    } else {
      this.options.logger?.info('shutdown complete');
    }
  }

  get completed(): boolean {
    return this.#completed;
  }
}

/**
 * Kill Chromium processes left behind by a previous crashed run.
 *
 * Matches only processes whose command line contains `userDataDirPrefix`, which
 * is unique to this application. A blanket `chrome.exe` kill would close the
 * user's own browser, and on a shared VPS someone else's too — never do that.
 *
 * Returns the pids it killed. Best-effort by design: failures are reported, not
 * thrown, because this runs at startup and must not prevent a run from starting.
 */
export async function sweepOrphanedBrowsers(
  userDataDirPrefix: string,
  options: { logger?: Logger; dryRun?: boolean } = {},
): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const pids: number[] = [];
  try {
    if (process.platform === 'win32') {
      // WMIC is deprecated but still the least-bad way to read command lines
      // without a native dependency; PowerShell's CIM is the fallback.
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${userDataDirPrefix}*' } | ` +
          `Select-Object -ExpandProperty ProcessId`,
      ]);
      for (const line of stdout.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
    } else {
      const { stdout } = await run('ps', ['-Ao', 'pid=,command=']);
      for (const line of stdout.split('\n')) {
        if (!line.includes(userDataDirPrefix)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
      }
    }
  } catch (error) {
    options.logger?.debug({ err: String(error) }, 'orphan sweep could not enumerate processes');
    return [];
  }

  if (options.dryRun === true) return pids;

  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already gone, or not ours to kill.
    }
  }

  if (killed.length > 0) {
    options.logger?.warn({ pids: killed }, 'killed orphaned browser processes from a previous run');
  }
  return killed;
}
