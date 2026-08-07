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
import { safeSegment } from '../core/util/paths.js';
import { PAGE } from './page.js';
import * as api from './api.js';
import { TaskManager, cliEntryPoint, type TaskName } from './tasks.js';

export interface UiServerOptions {
  readonly config: ResolvedConfig;
  readonly port?: number;
  readonly host?: string;
  readonly logger?: Logger;
  /** Allow the config editor to write gms.config.local.yaml. */
  readonly allowConfigWrite?: boolean;
  /** Let the page start and stop scrapes, imports and exports. */
  readonly allowControl?: boolean;
  readonly configFile?: string;
}

/**
 * Commands the dashboard may start, and how its form fields map to flags.
 *
 * An allow-list of *named* commands with typed parameters, never a free-text
 * command line. The page can ask for "run with 4 workers"; it cannot ask for
 * anything else, so a compromised page cannot execute arbitrary programs.
 */
const COMMANDS: Record<
  TaskName,
  { label: string; build: (input: Record<string, unknown>) => string[] }
> = {
  run: {
    label: 'Scrape Google Maps',
    build: (input) => {
      const args = ['run'];
      const workers = clampInt(input['workers'], 1, 32);
      const maxJobs = clampInt(input['maxJobs'], 1, 100_000);
      if (workers !== null) args.push('--workers', String(workers));
      if (maxJobs !== null) args.push('--max-jobs', String(maxJobs));
      if (input['headful'] === true) args.push('--headful');
      return args;
    },
  },
  enrich: {
    label: 'Find email addresses',
    build: (input) => {
      const args = ['enrich', 'emails'];
      const workers = clampInt(input['workers'], 1, 64);
      const maxDomains = clampInt(input['maxDomains'], 1, 100_000);
      if (workers !== null) args.push('--workers', String(workers));
      if (maxDomains !== null) args.push('--max-domains', String(maxDomains));
      return args;
    },
  },
  plan: {
    label: 'Create jobs',
    build: (input) => {
      const args = ['plan'];
      const cities = asList(input['cities']);
      const categories = asList(input['categories']);
      const limit = clampInt(input['limit'], 1, 1_000_000);
      if (cities !== null) args.push('--cities', cities);
      if (categories !== null) args.push('--categories', categories);
      if (limit !== null) args.push('--limit', String(limit));
      return args;
    },
  },
  'export-sheets': {
    label: 'Send to Google Sheet',
    build: (input) => {
      const args = ['export', 'sheets'];
      const entity = input['entity'];
      if (entity === 'businesses' || entity === 'emails' || entity === 'leads-flat') {
        args.push('--entity', entity);
      }
      // A spreadsheet id is [A-Za-z0-9_-]; anything else is not one.
      const id = input['spreadsheetId'];
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(id.trim())) {
        args.push('--spreadsheet-id', id.trim());
      }
      if (input['full'] === true) args.push('--full');
      return args;
    },
  },
  export: {
    label: 'Export CSV',
    build: (input) => {
      const args = ['export', 'csv'];
      const entity = input['entity'];
      if (entity === 'businesses' || entity === 'emails' || entity === 'leads-flat') {
        args.push('--entity', entity);
      }
      if (input['full'] === true) args.push('--full');
      if (input['excelSafe'] === true) args.push('--excel-safe');
      if (input['splitByState'] === true) args.push('--split-by', 'state');
      return args;
    },
  },
  'import-cities': {
    label: 'Import cities',
    build: (input) => buildImport('cities', input),
  },
  'import-categories': {
    label: 'Import categories',
    build: (input) => buildImport('categories', input),
  },
};

function buildImport(what: 'cities' | 'categories', input: Record<string, unknown>): string[] {
  const file = typeof input['file'] === 'string' ? input['file'] : '';
  const args = ['import', what, file];
  const sheet = input['sheet'];
  if (typeof sheet === 'string' && sheet !== '') args.push('--sheet', sheet);
  return args;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Accept a comma-separated selector list, stripping anything shell-ish. */
function asList(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const cleaned = value
    .split(',')
    .map((s) => s.trim().replace(/[^\w\s.-]/g, ''))
    .filter((s) => s !== '')
    .join(',');
  return cleaned === '' ? null : cleaned;
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

/** Read a JSON request body, with a size cap. */
function readBody(req: http.IncomingMessage, done: (body: unknown) => void): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString('utf8');
    if (raw.length > 64_000) req.destroy();
  });
  req.on('end', () => {
    try {
      done(JSON.parse(raw));
    } catch {
      done({});
    }
  });
}

export function startUiServer(options: UiServerOptions): Promise<RunningServer> {
  const { config } = options;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4600;

  const tasks =
    options.allowControl === true
      ? new TaskManager({
          cliEntry: cliEntryPoint(),
          cwd: config.paths.root,
          ...(options.configFile !== undefined && { configFile: options.configFile }),
        })
      : null;

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

      if (url.pathname === '/api/tasks' && req.method === 'GET') {
        json(res, 200, {
          enabled: options.allowControl === true,
          running: tasks?.running() ?? null,
          tasks: (tasks?.list() ?? []).slice(0, 12),
        });
        return;
      }

      if (url.pathname === '/api/tasks/start' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --allow-control' });
          return;
        }
        readBody(req, (body) => {
          const input = body as { command?: string; options?: Record<string, unknown> };
          const name = input.command as TaskName | undefined;
          const command = name !== undefined ? COMMANDS[name] : undefined;
          if (command === undefined) {
            json(res, 400, { error: `unknown command: ${String(input.command)}` });
            return;
          }
          const started = tasks.start({
            name: name!,
            label: command.label,
            args: command.build(input.options ?? {}),
          });
          json(res, started.ok ? 200 : 409, started.ok ? started.task : { error: started.error });
        });
        return;
      }

      if (url.pathname === '/api/tasks/stop' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled' });
          return;
        }
        readBody(req, (body) => {
          const id = (body as { id?: string }).id ?? '';
          json(res, 200, { stopped: tasks.stop(id) });
        });
        return;
      }

      // Seed-file upload. The browser posts the raw bytes with the name in the
      // query string, which avoids parsing multipart form data by hand — the
      // only thing a dependency would buy here.
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled' });
          return;
        }
        const name = safeSegment(url.searchParams.get('name') ?? 'upload.xlsx', 64);
        const dir = path.join(config.paths.dataDir, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, name);

        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // A seed workbook is well under this; the cap stops a runaway upload
          // filling the disk the database lives on.
          if (size > 64 * 1024 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            fs.writeFileSync(target, Buffer.concat(chunks));
            json(res, 200, { file: target, bytes: size });
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        });
        return;
      }

      /** Sheet names in an uploaded workbook, so the user can pick one. */
      if (url.pathname === '/api/sheets' && req.method === 'GET') {
        const file = url.searchParams.get('file') ?? '';
        void import('../importers/xlsx.js')
          .then(({ sheetNames }) => sheetNames(file))
          .then((names) => {
            json(res, 200, { sheets: names });
          })
          .catch((error: unknown) => {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) });
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
            // Stop child tasks first: a scrape outliving the dashboard would
            // keep a browser and a job lease with nothing supervising it.
            tasks?.stopAll();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
