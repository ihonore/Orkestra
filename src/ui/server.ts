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
import { loadConfig, mergeDeep } from '../config/loader.js';
import { checkSheets } from '../exporters/sheets-check.js';
import { resolvePath } from '../core/util/paths.js';
import {
  KeyFileError,
  defaultCredentialsDir,
  keyEmail,
  parseServiceAccountKey,
  parseSheetName,
  parseSpreadsheetId,
  portablePath,
  saveServiceAccountKey,
  keyFileName,
} from './sheets.js';
import { openDatabaseFromConfig } from '../db/client.js';
import { JobsRepository } from '../db/repositories/jobs.js';
import type { SeedKind } from '../db/repositories/seed-jobs.js';
import { errorMessage, isAppError } from '../core/errors/taxonomy.js';
import type { Logger } from '../core/logging/logger.js';
import { saveSeedFiles } from '../seeds/bundled.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { ExportsRepository } from '../db/repositories/exports.js';
import {
  SHEET_LAYOUT_ENTITY,
  VIEWS,
  countRemaining,
  sharedLeadEntity,
  startingCursor,
} from '../views/index.js';
import { Autopilot, normalizeAutopilot, type Snapshot } from './autopilot.js';
import { queueView, setQueuePlan, syncQueue } from '../seeds/queue.js';
import { pendingSheetRebuild, requeueFinished, rescrapeProgress } from '../seeds/rescrape.js';
import {
  addCategory,
  addCity,
  listCategories,
  listCities,
  removeSeed,
  setSeedActive,
  updateCategory,
  updateCity,
  type SeedForm,
} from '../seeds/manage.js';
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
  /** Where "Save to seeds/" writes. Defaults to the project's own seeds/ folder. */
  readonly seedsDir?: string;
  /** Where an uploaded Sheets key is stored. Defaults to ~/gms-credentials. */
  readonly credentialsDir?: string;
  /** How often autopilot looks for work. Tests shorten it. */
  readonly autopilotIntervalMs?: number;
}

const AUTOPILOT_KEY = 'autopilot';

/** What autopilot needs to know, read in one short read-only visit. */
function autopilotSnapshot(
  driver: ReturnType<typeof openDatabaseFromConfig>,
  entity: string,
  spreadsheetId: string | null,
): Snapshot {
  const count = (sql: string, params: readonly (string | number)[] = []): number =>
    driver.prepare<{ n: number }>(sql).get(params)?.n ?? 0;

  let rowsUnsent: number | null = null;
  let lastSentAt: number | null = null;
  if (spreadsheetId !== null && spreadsheetId !== '') {
    const partner = sharedLeadEntity(entity);
    const cursors = new ExportsRepository(driver);
    const own = cursors.position('sheets', spreadsheetId, entity);
    const other = partner === null ? null : cursors.position('sheets', spreadsheetId, partner);
    const toCursor = (row: typeof own) =>
      row === null ? null : { lastId: row.last_id, lastSubId: row.last_sub_id };
    rowsUnsent = countRemaining(
      driver,
      VIEWS[entity]!,
      startingCursor(entity, toCursor(own), toCursor(other)),
    );
    const last = Math.max(own?.last_at ?? 0, other?.last_at ?? 0);
    lastSentAt = last > 0 ? last : null;
  }

  return {
    rescrape: rescrapeProgress(driver),
    rebuildPending: spreadsheetId !== null && pendingSheetRebuild(driver) === entity,
    // Exactly what a worker could claim: the same conditions as the claim.
    searchesQueued: count(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE automation_id = 'google-maps' AND status = 'pending' AND attempts < max_attempts`,
    ),
    // And what the crawler could claim.
    sitesQueued: count(
      `SELECT COUNT(*) AS n FROM domains
        WHERE status = 'pending' AND is_social = 0
          AND (next_eligible_at IS NULL OR next_eligible_at <= ?)`,
      [Date.now()],
    ),
    rowsUnsent,
    lastSentAt,
    sheetEntity: entity,
  };
}

/** Config paths the Sheets step may write, and nothing else. */
const SHEETS_KEYS = new Set([
  'exporters.sheets.spreadsheetId',
  'exporters.sheets.sheetName',
  'exporters.sheets.businessSheetName',
  'exporters.sheets.layout',
  'exporters.sheets.credentialsFile',
]);

const SHEET_LAYOUTS = new Set(['business', 'email', 'all']);

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
      if (typeof entity === 'string' && EXPORT_ENTITIES.has(entity)) {
        args.push('--entity', entity);
      }
      // A spreadsheet id is [A-Za-z0-9_-]; anything else is not one.
      const id = input['spreadsheetId'];
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(id.trim())) {
        args.push('--spreadsheet-id', id.trim());
      }
      if (input['full'] === true) args.push('--full');
      if (input['rebuild'] === true) args.push('--rebuild');
      return args;
    },
  },
  export: {
    label: 'Export CSV',
    build: (input) => {
      const args = ['export', 'csv'];
      const entity = input['entity'];
      if (typeof entity === 'string' && EXPORT_ENTITIES.has(entity)) {
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

/** Views the export commands accept, as the CLI's --entity choices. */
const EXPORT_ENTITIES = new Set([
  'leads-flat',
  'leads-with-email',
  'leads-by-business',
  'businesses',
  'emails',
]);

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
  allowed: ReadonlySet<string> = new Set(EDITABLE.map((f) => f.path)),
): { ok: true } | { ok: false; error: string } {
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
  // Merged deeply, as the loader does. A shallow spread let a local
  // `exporters.sheets` with one key replace the base file's whole `exporters`
  // block, so the check ran against a config that never exists.
  const baseFile = path.join(config.paths.root, 'gms.config.yaml');
  const base = fs.existsSync(baseFile)
    ? ((YAML.parse(fs.readFileSync(baseFile, 'utf8')) as Record<string, unknown> | null) ?? {})
    : {};
  const merged = ConfigSchema.safeParse(mergeDeep(base, existing));

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

/**
 * Whether a request really comes from this dashboard's own page.
 *
 * Binding to loopback keeps other *machines* out, but not other *websites*: any
 * page open in the same browser can send requests to 127.0.0.1. Two checks
 * close that:
 *
 *  - The Host header must name this server. A DNS-rebinding page arrives as
 *    `Host: attacker.example:4600` and is refused, so it can never read leads.
 *  - A write must not come from another origin. A cross-site `fetch` with a
 *    `text/plain` body is a "simple request" that skips the CORS preflight,
 *    and the body parser here does not care about content types — so without
 *    this, any website could start a scrape or rewrite the config.
 *
 * Tools such as curl send neither Origin nor Sec-Fetch-Site and are allowed:
 * they are not a browser that can be tricked into sending a request.
 */
function isSameOrigin(req: http.IncomingMessage, host: string, port: number): boolean {
  const allowed = new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]);
  const requestHost = req.headers.host ?? '';
  if (!allowed.has(requestHost)) return false;

  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${requestHost}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

interface SeedRequest {
  readonly kind?: unknown;
  readonly op?: unknown;
  readonly id?: unknown;
  readonly values?: SeedForm;
}

/** Apply one seed edit from the dashboard. Throws a SeedError the page can show. */
function applySeedEdit(driver: ReturnType<typeof openDatabaseFromConfig>, body: SeedRequest) {
  const kind: SeedKind | null =
    body.kind === 'city' ? 'city' : body.kind === 'category' ? 'category' : null;
  if (kind === null) throw new Error(`unknown kind: ${String(body.kind)}`);
  const id = Number(body.id);
  const values = body.values ?? {};

  switch (body.op) {
    case 'add':
      return kind === 'city' ? addCity(driver, values) : addCategory(driver, values);
    case 'update':
      return kind === 'city' ? updateCity(driver, id, values) : updateCategory(driver, id, values);
    case 'pause':
      return setSeedActive(driver, kind, id, false);
    case 'resume':
      return setSeedActive(driver, kind, id, true);
    case 'delete':
      return removeSeed(driver, kind, id);
    default:
      throw new Error(`unknown operation: ${String(body.op)}`);
  }
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Read a request body as text, refusing anything over `limit` bytes. */
function readText(
  req: http.IncomingMessage,
  limit: number,
  done: (text: string | null) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) over = true;
    else chunks.push(chunk);
  });
  req.on('end', () => done(over ? null : Buffer.concat(chunks).toString('utf8')));
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

/**
 * The page, named after the project, so two campaigns' dashboards open side by
 * side can be told apart at a glance — in the tab title and the sidebar.
 */
export function brandPage(html: string, name: string): string {
  if (name === 'gms') return html;
  const safe = name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return html
    .replace('<title>gms · sweep</title>', `<title>${safe} · sweep</title>`)
    .replace('<div class="brand">gms<span>.</span>', `<div class="brand">${safe}<span>.</span>`);
}

export function startUiServer(options: UiServerOptions): Promise<RunningServer> {
  const { config } = options;
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? config.ui.port;
  const page = brandPage(PAGE, config.project.name);

  const tasks =
    options.allowControl === true
      ? new TaskManager({
          cliEntry: cliEntryPoint(),
          cwd: config.paths.root,
          // The child gets the configured grace to finish its jobs; allow that
          // plus time to close the browser before resorting to a kill.
          stopTimeoutMs: (config.runtime.shutdownGraceSeconds + 30) * 1000,
          ...(options.configFile !== undefined && { configFile: options.configFile }),
        })
      : null;

  // A queue planned before the order existed has every job at one priority,
  // which runs it state by state. Order it once at startup so "Next up" is
  // true from the first look — only with --control, since a viewer must not
  // write.
  if (tasks !== null) {
    const driver = openDatabaseFromConfig(config);
    try {
      syncQueue(driver);
    } catch (error) {
      options.logger?.warn({ err: String(error) }, 'could not apply the queue order at startup');
    } finally {
      driver.close();
    }
  }

  // Configuration as it is on disk now, not as it was at startup: step 7
  // saves the sheet settings while the dashboard runs.
  const freshConfig = (): ResolvedConfig =>
    loadConfig({
      cwd: config.paths.root,
      ...(options.configFile !== undefined && { configFile: options.configFile }),
    });

  const autopilot =
    tasks === null
      ? null
      : new Autopilot({
          tasks,
          ...(options.logger !== undefined && { logger: options.logger }),
          ...(options.autopilotIntervalMs !== undefined && {
            intervalMs: options.autopilotIntervalMs,
          }),
          load: () => {
            try {
              const driver = openDatabaseFromConfig(config, { readonly: true });
              try {
                const raw = new MetaRepository(driver).get(AUTOPILOT_KEY);
                return normalizeAutopilot(raw === undefined ? {} : JSON.parse(raw));
              } finally {
                driver.close();
              }
            } catch {
              return normalizeAutopilot({});
            }
          },
          save: (settings) => {
            const driver = openDatabaseFromConfig(config);
            try {
              new MetaRepository(driver).set(AUTOPILOT_KEY, JSON.stringify(settings));
            } finally {
              driver.close();
            }
          },
          snapshot: () => {
            const sheets = freshConfig().exporters.sheets;
            const driver = openDatabaseFromConfig(config, { readonly: true });
            try {
              return autopilotSnapshot(
                driver,
                SHEET_LAYOUT_ENTITY[sheets.layout],
                sheets.spreadsheetId ?? null,
              );
            } finally {
              driver.close();
            }
          },
          start: (name, input) => {
            const command = COMMANDS[name];
            return tasks.start({ name, label: command.label, args: command.build(input) });
          },
        });
  autopilot?.begin();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    if (!isSameOrigin(req, host, actualPort)) {
      json(res, 403, { error: 'request refused: not from this dashboard' });
      return;
    }

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
        res.end(page);
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
          // Every running task, then the most recent finished ones. A plain
          // "newest 12" would drop a scrape started days ago once autopilot
          // had run a dozen exports since.
          tasks: [
            ...(tasks?.list() ?? []).filter((t) => t.state === 'running'),
            ...(tasks?.list() ?? []).filter((t) => t.state !== 'running').slice(0, 8),
          ],
        });
        return;
      }

      if (url.pathname === '/api/tasks/start' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
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
          const task = tasks.get(id);
          const stopped = tasks.stop(id);
          // Otherwise autopilot would start it again on its next tick, and the
          // Stop button would look broken.
          if (stopped && task !== undefined) {
            autopilot?.standDown(
              `Autopilot turned off because you stopped "${task.label}". Turn it on again when you are ready.`,
            );
          }
          json(res, 200, { stopped });
        });
        return;
      }

      if (url.pathname === '/api/autopilot' && req.method === 'GET') {
        json(
          res,
          200,
          autopilot === null ? { available: false } : { available: true, ...autopilot.view() },
        );
        return;
      }

      if (url.pathname === '/api/autopilot' && req.method === 'POST') {
        if (autopilot === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        readBody(req, (body) => {
          try {
            json(res, 200, { available: true, ...autopilot.update(body) });
          } catch (error) {
            json(res, 500, { error: errorMessage(error) });
          }
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
        // Only files the page uploaded. This endpoint opens whatever it is
        // given, and the rest of the disk is none of the dashboard's business.
        const uploads = path.resolve(config.paths.dataDir, 'uploads');
        const file = path.resolve(uploads, url.searchParams.get('file') ?? '');
        if (path.dirname(file) !== uploads) {
          json(res, 400, { error: 'only uploaded workbooks can be listed' });
          return;
        }
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
        // Retrying rewrites job rows and discards their resume points. It is a
        // write like any other, so it belongs behind the same gate — a
        // dashboard started without --control must not be able to change data.
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        const driver = openDatabaseFromConfig(config);
        try {
          // Failed only. The CLI default also takes `paused`, but here those
          // are searches of a city or service someone paused on purpose.
          const n = new JobsRepository(driver).retry({
            automationId: 'google-maps',
            status: 'failed',
          });
          syncQueue(driver);
          json(res, 200, { retried: n });
        } finally {
          driver.close();
        }
        return;
      }

      if (url.pathname === '/api/jobs/rescrape' && req.method === 'POST') {
        // Every finished search back into the queue, so its businesses are
        // read again with the current extraction. Businesses are matched and
        // updated, never duplicated; each search re-runs once.
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        const driver = openDatabaseFromConfig(config);
        try {
          // Also holds the sheet until these have run, so it never receives
          // the data the re-scrape exists to correct.
          const n = requeueFinished(driver);
          options.logger?.info({ count: n }, 'finished searches queued for a re-scrape');
          json(res, 200, { queued: n });
        } finally {
          driver.close();
        }
        return;
      }

      if (url.pathname === '/api/seeds' && req.method === 'GET') {
        const kind = url.searchParams.get('kind') === 'categories' ? 'categories' : 'cities';
        json(
          res,
          200,
          withDb((d) => (kind === 'cities' ? listCities(d) : listCategories(d))),
        );
        return;
      }

      if (url.pathname === '/api/seeds' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        readBody(req, (body) => {
          const driver = openDatabaseFromConfig(config);
          try {
            const result = applySeedEdit(driver, body as SeedRequest);
            options.logger?.info({ edit: body }, 'seed edited from dashboard');
            json(res, 200, result);
          } catch (error) {
            json(res, 400, {
              error: errorMessage(error),
              ...(isAppError(error) && error.hint !== undefined && { hint: error.hint }),
            });
          } finally {
            driver.close();
          }
        });
        return;
      }

      if (url.pathname === '/api/queue' && req.method === 'GET') {
        json(
          res,
          200,
          withDb((d) => queueView(d)),
        );
        return;
      }

      if (url.pathname === '/api/queue' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        readBody(req, (body) => {
          const driver = openDatabaseFromConfig(config);
          try {
            const result = setQueuePlan(driver, body as Record<string, unknown>);
            options.logger?.info({ plan: result.plan }, 'queue plan changed from dashboard');
            json(res, 200, { ...result, ...queueView(driver) });
          } catch (error) {
            json(res, 400, { error: errorMessage(error) });
          } finally {
            driver.close();
          }
        });
        return;
      }

      // ── Google Sheets ───────────────────────────────────────────────────
      // Read from a fresh load of the config files, not the copy taken at
      // startup, so a setting saved here is visible — and used by the next
      // export, which runs as a new process — without restarting.
      const sheetsSettings = () => {
        const fresh = loadConfig({
          cwd: config.paths.root,
          ...(options.configFile !== undefined && { configFile: options.configFile }),
        });
        const settings = fresh.exporters.sheets;
        const keyFile =
          settings.credentialsFile !== undefined
            ? resolvePath(settings.credentialsFile, fresh.paths.root)
            : undefined;
        return {
          fresh,
          view: {
            spreadsheetId: settings.spreadsheetId ?? null,
            layout: settings.layout,
            // The tab the chosen layout writes to: by-business has its own.
            sheetName:
              settings.layout === 'business' ? settings.businessSheetName : settings.sheetName,
            credentialsFile: settings.credentialsFile ?? null,
            keyFound: keyFile !== undefined && fs.existsSync(keyFile),
            clientEmail: keyFile !== undefined ? keyEmail(keyFile) : null,
            writable: options.allowConfigWrite === true,
          },
        };
      };

      if (url.pathname === '/api/sheets/settings' && req.method === 'GET') {
        json(res, 200, sheetsSettings().view);
        return;
      }

      if (url.pathname === '/api/sheets/settings' && req.method === 'POST') {
        if (options.allowConfigWrite !== true) {
          json(res, 403, { error: 'settings are read-only — restart with --control' });
          return;
        }
        readBody(req, (body) => {
          const input = body as { spreadsheet?: unknown; sheetName?: unknown; layout?: unknown };
          const layout =
            typeof input.layout === 'string' && SHEET_LAYOUTS.has(input.layout)
              ? (input.layout as 'business' | 'email' | 'all')
              : 'business';
          const spreadsheetId = parseSpreadsheetId(input.spreadsheet);
          if (spreadsheetId === null) {
            json(res, 400, {
              error:
                'That is not a Google Sheets link or id. Copy the address of the sheet from the browser.',
            });
            return;
          }
          const sheetName = parseSheetName(
            input.sheetName ?? (layout === 'business' ? 'Leads by business' : 'Leads'),
          );
          if (sheetName === null) {
            json(res, 400, { error: 'The tab name must be 1 to 100 characters.' });
            return;
          }
          const result = writeLocalConfig(
            config,
            {
              'exporters.sheets.spreadsheetId': spreadsheetId,
              'exporters.sheets.layout': layout,
              [layout === 'business'
                ? 'exporters.sheets.businessSheetName'
                : 'exporters.sheets.sheetName']: sheetName,
            },
            SHEETS_KEYS,
          );
          if (!result.ok) {
            json(res, 400, { error: result.error });
            return;
          }
          const { view } = sheetsSettings();
          // Something can outrank the local file. Saying "saved" while the old
          // id stays in force would be a lie, so say what is in the way.
          const overridden =
            view.spreadsheetId !== spreadsheetId ||
            view.sheetName !== sheetName ||
            view.layout !== layout;
          json(res, 200, {
            ...view,
            ...(overridden && {
              warning:
                options.configFile !== undefined
                  ? 'Saved to gms.config.local.yaml, but this dashboard was started with --config, ' +
                    'which skips that file. Restart it without --config.'
                  : 'Saved, but a GMS_EXPORTERS__SHEETS__* environment variable overrides it.',
            }),
          });
        });
        return;
      }

      if (url.pathname === '/api/sheets/key' && req.method === 'POST') {
        if (options.allowConfigWrite !== true) {
          json(res, 403, { error: 'settings are read-only — restart with --control' });
          return;
        }
        // A service-account key is ~2.4 KB. The body is never logged: it
        // carries a private key.
        readText(req, 64_000, (text) => {
          try {
            if (text === null) throw new KeyFileError('That file is far too large to be a key.');
            const { clientEmail } = parseServiceAccountKey(text);
            const file = saveServiceAccountKey(
              text,
              options.credentialsDir ?? defaultCredentialsDir(),
              keyFileName(config.project.name),
            );
            const result = writeLocalConfig(
              config,
              { 'exporters.sheets.credentialsFile': portablePath(file) },
              SHEETS_KEYS,
            );
            if (!result.ok) {
              json(res, 400, { error: result.error });
              return;
            }
            options.logger?.info({ clientEmail }, 'sheets key saved from dashboard');
            json(res, 200, { ...sheetsSettings().view, savedTo: file });
          } catch (error) {
            json(res, error instanceof KeyFileError ? 400 : 500, { error: errorMessage(error) });
          }
        });
        return;
      }

      if (url.pathname === '/api/sheets/check' && req.method === 'POST') {
        void checkSheets(sheetsSettings().fresh)
          .then((results) => {
            json(res, 200, { results });
          })
          .catch((error: unknown) => {
            json(res, 500, { error: errorMessage(error) });
          });
        return;
      }

      if (url.pathname === '/api/seeds/save' && req.method === 'POST') {
        if (tasks === null) {
          json(res, 403, { error: 'controls are disabled — restart with --control' });
          return;
        }
        json(
          res,
          200,
          withDb((d) => saveSeedFiles(d, options.seedsDir ?? config.paths.seedsDir)),
        );
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
            autopilot?.end();
            tasks?.stopAll();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
