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

export type ShutdownReason = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK' | 'parent' | 'manual';

/** What a parent process sends over IPC to ask for a graceful stop. */
export const STOP_MESSAGE = 'gms:stop';

/** Controllers currently installed in this process, for {@link listenForParentStop}. */
const installed = new Set<ShutdownController>();

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
    installed.add(this);
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
    installed.delete(this);
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

  /** Whether a stop was ever requested. False for a run that ended on its own. */
  get triggered(): boolean {
    return this.#shuttingDown;
  }

  /**
   * Exit the process, once, with the conventional code for a signal.
   *
   * Nothing here calls `process.exit` on the happy path — the process should end
   * because its event loop is empty, which is the only way to be sure every
   * write has flushed. But a single leaked handle (an HTTP agent, a log stream,
   * a listener) then keeps a *stopped* run alive indefinitely, which used to be
   * hidden by Playwright's own SIGINT handler calling process.exit(130) out from
   * under us. So: ask for the clean exit, and force one shortly after if the
   * loop has not drained.
   *
   * The timer is unref'd, so it cannot itself be the thing keeping the process
   * up — if everything else has finished, the process is already gone before it
   * fires.
   */
  exitWhenIdle(graceMs = 2_000): void {
    if (!this.#shuttingDown) return;
    process.exitCode = 130;
    const bail = setTimeout(() => {
      (this.options.exit ?? process.exit.bind(process))(130);
    }, graceMs);
    bail.unref?.();
  }
}

/**
 * Kill Chromium processes left behind by a previous crashed run.
 *
 * Two conditions, and both are required:
 *
 *  1. The command line carries `marker`, which this application puts there and
 *     nothing else does. A blanket `chrome.exe` kill would close the user's own
 *     browser, and on a shared VPS someone else's too — never do that. Matching
 *     on Playwright's temp profile path is nearly as bad, since every Playwright
 *     project on the machine shares that shape.
 *  2. The process is genuinely orphaned — its parent is gone. Without this a
 *     second `gms run`, which the job leasing makes perfectly safe, would kill
 *     the browsers of the first one on startup.
 *
 * Returns the pids it killed. Best-effort by design: failures are reported, not
 * thrown, because this runs at startup and must not prevent a run from starting.
 */
export async function sweepOrphanedBrowsers(
  marker: string,
  options: { logger?: Logger; dryRun?: boolean } = {},
): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const pids: number[] = [];
  try {
    if (process.platform === 'win32') {
      // PowerShell's CIM rather than the deprecated WMIC. ParentProcessId comes
      // back too, so the orphan test is the same as on POSIX: a parent that is
      // no longer running.
      // No Name filter. The default headless launch is chrome-headless-shell.exe,
      // not chrome.exe, so filtering on the latter matched nothing at all — and
      // `channel: 'chrome'` or a custom executablePath change the name again.
      // The marker is what identifies our processes; the name adds nothing but
      // a way to miss them.
      const { stdout } = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | ` +
          `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
          `ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`,
      ]);
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(pid) || pid === undefined || pid <= 0) continue;
        if (pid === process.pid) continue;
        if (parent !== undefined && isAlive(parent)) continue;
        pids.push(pid);
      }
    } else {
      const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,command=']);
      for (const line of stdout.split('\n')) {
        if (!line.includes(marker)) continue;
        const [pid, parent] = line.trim().split(/\s+/, 2).map(Number);
        if (!Number.isInteger(pid) || pid === undefined || pid <= 0) continue;
        if (pid === process.pid) continue;
        // Re-parented to init means the launcher is gone. A browser whose
        // parent is still alive belongs to a run that is still working.
        if (parent !== 1) continue;
        pids.push(pid);
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

/** Whether a pid is currently running. Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accept a stop request from the process that spawned this one.
 *
 * The dashboard runs commands as child processes and used to stop them with
 * SIGTERM. Windows has no SIGTERM: Node implements `child.kill()` there as
 * TerminateProcess, which runs no handler at all — so on the VPS every Stop
 * click killed a scrape outright, left its leases held until they expired, and
 * orphaned Chromium. A message over the IPC channel works the same everywhere,
 * and lands in the same graceful path as Ctrl-C.
 *
 * The parent disappearing (closed window, crash) counts as a stop request
 * too: a scrape with no dashboard supervising it is not what anyone started.
 *
 * A process with no {@link ShutdownController} installed (an import, a plan)
 * has no cleanup to run, so it simply exits, as it would on SIGTERM.
 *
 * Does nothing unless the process was spawned with an IPC channel.
 */
export function listenForParentStop(
  exit: (code: number) => void = process.exit.bind(process),
): void {
  if (typeof process.send !== 'function') return;

  const stop = (): void => {
    if (installed.size === 0) {
      exit(130);
      return;
    }
    // A controller already shutting down must not be asked again: a second
    // request escalates to an immediate exit, which is exactly what the
    // parent's own exit (a disconnect right after the stop message) would do.
    for (const controller of installed) {
      if (!controller.isShuttingDown) void controller.shutdown('parent');
    }
  };

  process.on('message', (message) => {
    if (message === STOP_MESSAGE) stop();
  });
  process.on('disconnect', stop);
  // Listening keeps the channel referenced, which would hold the event loop
  // open and stop a finished command from ever exiting.
  process.channel?.unref();
}
