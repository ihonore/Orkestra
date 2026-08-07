/**
 * The local dashboard server.
 *
 * Binds to loopback only. This page exposes scraped contact data and lets you
 * edit configuration, so it must not be reachable from the network — there is no
 * authentication because there is no remote access, and those two facts have to
 * stay true together.
 *
 * No framework and no build step: one `node:http` server, one HTML document.
 * The dependency budget for a local viewer is zero.
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ResolvedConfig } from '../config/schema.js';
import { ConfigSchema } from '../config/schema.js';
import { openDatabaseFromConfig } from '../db/client.js';
import { JobsRepository } from '../db/repositories/jobs.js';
import type { Logger } from '../core/logging/logger.js';
import { PAGE } from './page.js';
import * as api from './api.js';

export interface UiServerOptions {
  readonly config: ResolvedConfig;
  readonly port?: number;
  readonly host?: string;
  readonly logger?: Logger;
  /** Allow the config editor to write gms.config.local.yaml. */
  readonly allowConfigWrite?: boolean;
}

/**
 * Settings the dashboard may change.
 *
 * A deliberate allow-list, not the whole schema. Paths and the database driver
 * are excluded: changing `dataDir` from a web form would silently orphan the
 * database you are looking at. These are the operational dials — the ones worth
 * turning between runs.
 */
const EDITABLE: readonly { path: string; label: string; kind: 'number' | 'boolean' | 'range' }[] = [
  { path: 'runtime.workers', label: 'Browser workers', kind: 'number' },
  { path: 'runtime.httpWorkers', label: 'Email crawl workers', kind: 'number' },
  { path: 'runtime.jobLeaseSeconds', label: 'Job lease (s)', kind: 'number' },
  { path: 'browser.headless', label: 'Headless browser', kind: 'boolean' },
  { path: 'browser.jobsPerContext', label: 'Jobs per context', kind: 'number' },
  { path: 'humanize.delayBetweenListingsMs', label: 'Delay between listings (ms)', kind: 'range' },
  { path: 'humanize.delayBetweenJobsMs', label: 'Delay between jobs (ms)', kind: 'range' },
  { path: 'enrichment.websiteEmails.maxDepth', label: 'Crawl depth', kind: 'number' },
  { path: 'enrichment.websiteEmails.maxPages', label: 'Pages per site', kind: 'number' },
  {
    path: 'enrichment.websiteEmails.validation.excludeGovernment',
    label: 'Exclude government (.gov/.mil)',
    kind: 'boolean',
  },
  {
    path: 'enrichment.websiteEmails.validation.excludeEducation',
    label: 'Exclude education (.edu)',
    kind: 'boolean',
  },
];

function getPath(object: unknown, dotted: string): unknown {
  let current: unknown = object;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(object: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let current = object;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // Nothing here is meant to be embedded anywhere else.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  res.end(text);
}

/**
 * Apply an edit to `gms.config.local.yaml`.
 *
 * Validated through the same zod schema the CLI uses *before* anything is
 * written, so the UI cannot produce a config that then fails to load and leaves
 * the tool unable to start.
 */
function writeLocalConfig(
  config: ResolvedConfig,
  updates: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const allowed = new Set(EDITABLE.map((f) => f.path));
  for (const key of Object.keys(updates)) {
    if (!allowed.has(key)) return { ok: false, error: `not editable: ${key}` };
  }

  const file = path.join(config.paths.root, 'gms.config.local.yaml');
  const existing: Record<string, unknown> = fs.existsSync(file)
    ? ((YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {})
    : {};

  for (const [key, value] of Object.entries(updates)) setPath(existing, key, value);

  // Validate the merged result, not just the patch: a value that is fine alone
  // can still violate a cross-field rule such as adaptiveConcurrency.min <= max.
  const merged = ConfigSchema.safeParse({
    ...(YAML.parse(
      fs.existsSync(path.join(config.paths.root, 'gms.config.yaml'))
        ? fs.readFileSync(path.join(config.paths.root, 'gms.config.yaml'), 'utf8')
        : '{}',
    ) as Record<string, unknown>),
    ...existing,
  });

  if (!merged.success) {
    const first = merged.error.issues[0];
    return {
      ok: false,
      error: first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'invalid config',
    };
  }

  fs.writeFileSync(
    file,
    `# Written by the gms dashboard. Overrides gms.config.yaml.\n${YAML.stringify(existing)}`,
    'utf8',
  );
  return { ok: true };
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

export function startUiServer(options: UiServerOptions): Promise<RunningServer> {
  const { config } = options;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4600;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // The database is opened per request and closed immediately. A long-lived
    // handle would hold a WAL read lock across an idle browser tab, and a
    // dashboard left open for days must not interfere with a running scrape.
    const withDb = <T>(work: (driver: ReturnType<typeof openDatabaseFromConfig>) => T): T => {
      const driver = openDatabaseFromConfig(config, { readonly: true });
      try {
        return work(driver);
      } finally {
        driver.close();
      }
    };

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
        });
        res.end(PAGE);
        return;
      }

      if (url.pathname === '/api/overview') {
        json(
          res,
          200,
          withDb((d) => api.overview(d)),
        );
        return;
      }

      if (url.pathname === '/api/progress') {
        const by = url.searchParams.get('by');
        const grouping = by === 'category' || by === 'state' ? by : 'city';
        json(
          res,
          200,
          withDb((d) => api.progress(d, grouping)),
        );
        return;
      }

      if (url.pathname === '/api/leads') {
        const query = {
          search: url.searchParams.get('search') ?? '',
          state: url.searchParams.get('state') ?? '',
          hasEmail: url.searchParams.get('hasEmail') === '1',
          hasPhone: url.searchParams.get('hasPhone') === '1',
          limit: Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100),
          offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0),
        };
        json(
          res,
          200,
          withDb((d) => ({ ...api.leads(d, query), states: api.states(d) })),
        );
        return;
      }

      if (url.pathname === '/api/failures') {
        json(
          res,
          200,
          withDb((d) => api.failures(d)),
        );
        return;
      }

      if (url.pathname === '/api/exports') {
        json(
          res,
          200,
          withDb((d) => api.exportCursors(d)),
        );
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'GET') {
        json(res, 200, {
          ...(api.configView(config) as object),
          editable: EDITABLE.map((field) => ({
            ...field,
            value: getPath(config, field.path),
          })),
          writable: options.allowConfigWrite === true,
        });
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        if (options.allowConfigWrite !== true) {
          json(res, 403, {
            error: 'config editing is disabled — restart with --allow-config-write',
          });
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          // A local form never sends more than a few hundred bytes.
          if (body.length > 64_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const updates = JSON.parse(body) as Record<string, unknown>;
            const result = writeLocalConfig(config, updates);
            if (result.ok) {
              options.logger?.info({ keys: Object.keys(updates) }, 'config updated from dashboard');
              json(res, 200, { ok: true, note: 'Saved. Restart a run for it to take effect.' });
            } else {
              json(res, 400, { error: result.error });
            }
          } catch {
            json(res, 400, { error: 'malformed request body' });
          }
        });
        return;
      }

      if (url.pathname === '/api/jobs/retry' && req.method === 'POST') {
        const driver = openDatabaseFromConfig(config);
        try {
          const n = new JobsRepository(driver).retry({ automationId: 'google-maps' });
          json(res, 200, { retried: n });
        } finally {
          driver.close();
        }
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      options.logger?.error({ err: String(error), path: url.pathname }, 'dashboard request failed');
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      // Read the port back rather than echoing what was asked for: with port 0
      // the OS assigns a free one, and reporting the request would print an
      // unusable http://127.0.0.1:0.
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;

      resolve({
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
