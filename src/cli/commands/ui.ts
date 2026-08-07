/**
 * `gms ui` — the local dashboard.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { ShutdownController } from '../../core/engine/shutdown.js';
import { startUiServer } from '../../ui/server.js';
import { keyValue, style, symbol } from '../output.js';

export interface UiCommandOptions {
  readonly config: ResolvedConfig;
  readonly port?: number;
  readonly open?: boolean;
  readonly allowConfigWrite?: boolean;
  readonly allowControl?: boolean;
  readonly configFile?: string;
}

export async function runUi(options: UiCommandOptions): Promise<void> {
  const server = await startUiServer({
    config: options.config,
    ...(options.port !== undefined && { port: options.port }),
    ...(options.allowConfigWrite !== undefined && {
      allowConfigWrite: options.allowConfigWrite,
    }),
    ...(options.allowControl !== undefined && { allowControl: options.allowControl }),
    ...(options.configFile !== undefined && { configFile: options.configFile }),
  });

  console.log(
    keyValue([
      ['dashboard', server.url],
      ['database', options.config.paths.databaseFile],
      ['controls', options.allowControl === true ? 'enabled' : 'view only'],
      ['settings', options.allowConfigWrite === true ? 'editable' : 'read-only'],
    ]),
  );
  console.log(
    `\n${symbol.ok} listening on ${style.cyan(server.url)}  ${style.grey('(Ctrl-C to stop)')}`,
  );
  if (options.allowControl !== true) {
    console.log(
      style.grey('This is a viewer. Use `gms ui --control` to run everything from the page.'),
    );
  }

  if (options.open === true) await openBrowser(server.url);

  // Hold the process open until interrupted; the server is the only work.
  const shutdown = new ShutdownController({ graceSeconds: 2 });
  shutdown.install();
  shutdown.onShutdown('http', () => server.close());
  await new Promise<void>((resolve) => {
    shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.close();
}

/** Open the default browser. Best-effort: failing to open is not an error. */
async function openBrowser(url: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    execFile(command, [url], () => undefined);
  } catch {
    // The URL is printed above; the user can click it.
  }
}
