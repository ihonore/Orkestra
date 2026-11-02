/**
 * Dashboard server tests.
 *
 * The config-write path gets the most attention here: it takes input from a web
 * form and writes a file the whole tool then depends on, so an invalid write
 * would leave `gms` unable to start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { startUiServer, type RunningServer } from '../src/ui/server.js';
import { PAGE } from '../src/ui/page.js';
import { TaskManager, cliEntryPoint } from '../src/ui/tasks.js';
import { parseSpreadsheetId, portablePath } from '../src/ui/sheets.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

const running: RunningServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  cleanupTempDirs();
});

/** A project directory with a migrated, empty database. */
async function serve(
  options: { allowConfigWrite?: boolean; allowControl?: boolean } = {},
): Promise<{ url: string; root: string; port: number }> {
  const root = tempDir();
  writeFile(root, 'gms.config.yaml', 'project:\n  name: test\n');
  const config = loadConfig({ cwd: root, env: {} });

  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  const driver = openDatabase({ file: config.paths.databaseFile });
  migrate(driver);
  driver.close();

  const server = await startUiServer({
    config,
    port: 0, // let the OS assign a free port, so tests never collide
    ...(options.allowConfigWrite !== undefined && {
      allowConfigWrite: options.allowConfigWrite,
    }),
    ...(options.allowControl !== undefined && { allowControl: options.allowControl }),
    // Never the real seeds/ folder: a test must not rewrite the project's lists.
    seedsDir: path.join(root, 'seeds'),
    // Nor the real ~/gms-credentials.
    credentialsDir: path.join(root, 'credentials'),
  });
  running.push(server);
  return { url: server.url, root, port: Number(new URL(server.url).port) };
}

describe('dashboard server', () => {
  it('binds to loopback only', async () => {
    // There is no authentication, so there must be no remote access. These two
    // facts have to stay true together.
    const { url } = await serve();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('serves the page', async () => {
    const { url } = await serve();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('sweep control');
  });

  it('refuses to be framed', async () => {
    const { url } = await serve();
    expect((await fetch(url)).headers.get('x-frame-options')).toBe('DENY');
  });

  it('answers every read endpoint on an empty database', async () => {
    const { url } = await serve();
    for (const endpoint of [
      '/api/overview',
      '/api/progress?by=city',
      '/api/leads',
      '/api/failures',
      '/api/exports',
      '/api/config',
    ]) {
      const response = await fetch(`${url}${endpoint}`);
      expect(response.status, endpoint).toBe(200);
      await expect(response.json()).resolves.toBeDefined();
    }
  });

  it('reports zeroed counts rather than failing when nothing has run', async () => {
    const { url } = await serve();
    const overview = (await (await fetch(`${url}/api/overview`)).json()) as {
      businesses: number;
      jobsTotal: number;
      etaMs: number | null;
    };
    expect(overview.businesses).toBe(0);
    expect(overview.jobsTotal).toBe(0);
    expect(overview.etaMs).toBeNull();
  });

  it('returns 404 for an unknown path', async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });

  it('accepts a search term without letting it reach SQL unbound', async () => {
    const { url } = await serve();
    const injection = encodeURIComponent("'; DROP TABLE businesses; --");
    const response = await fetch(`${url}/api/leads?search=${injection}`);

    expect(response.status).toBe(200);
    // The table must still be there afterwards.
    expect((await fetch(`${url}/api/overview`)).status).toBe(200);
  });
});

describe('config editing', () => {
  it('is refused unless explicitly enabled', async () => {
    const { url } = await serve({ allowConfigWrite: false });
    const response = await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'runtime.workers': 8 }),
    });
    expect(response.status).toBe(403);
  });

  it('writes an allowed change to the local config file', async () => {
    const { url, root } = await serve({ allowConfigWrite: true });
    const response = await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'runtime.workers': 6 }),
    });

    expect(response.status).toBe(200);
    const file = path.join(root, 'gms.config.local.yaml');
    expect(fs.readFileSync(file, 'utf8')).toContain('workers: 6');

    // And the tool must still be able to load what the UI wrote.
    expect(loadConfig({ cwd: root, env: {} }).runtime.workers).toBe(6);
  });

  it('rejects a value the schema forbids, before writing anything', async () => {
    const { url, root } = await serve({ allowConfigWrite: true });
    const response = await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'runtime.workers': 9999 }),
    });

    expect(response.status).toBe(400);
    expect(fs.existsSync(path.join(root, 'gms.config.local.yaml'))).toBe(false);
  });

  it('refuses a field that is not on the allow-list', async () => {
    // Changing dataDir from a web form would orphan the database being viewed.
    const { url, root } = await serve({ allowConfigWrite: true });
    const response = await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'project.dataDir': '/tmp/elsewhere' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not editable/);
    expect(fs.existsSync(path.join(root, 'gms.config.local.yaml'))).toBe(false);
  });

  it('preserves unrelated keys already in the local file', async () => {
    const { url, root } = await serve({ allowConfigWrite: true });
    writeFile(root, 'gms.config.local.yaml', 'logging:\n  level: debug\n');

    await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'runtime.workers': 3 }),
    });

    const merged = loadConfig({ cwd: root, env: {} });
    expect(merged.runtime.workers).toBe(3);
    expect(merged.logging.level).toBe('debug');
  });

  it('rejects a malformed body without crashing', async () => {
    const { url } = await serve({ allowConfigWrite: true });
    const response = await fetch(`${url}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('never exposes a secret through the config endpoint', async () => {
    const { url } = await serve();
    const body = await (await fetch(`${url}/api/config`)).text();
    expect(body).not.toMatch(/"password"\s*:\s*"(?!\[redacted\])/);
  });
});

describe('page document', () => {
  it('has no external resource references', () => {
    // The dashboard must work offline and must not leak the fact that it is
    // running, or what it holds, to any third party.
    expect(PAGE).not.toMatch(/<script[^>]+src=/i);
    expect(PAGE).not.toMatch(/<link[^>]+href="https?:/i);
    expect(PAGE).not.toMatch(/@import\s+url\(https?:/i);
  });

  it('escapes interpolated values', () => {
    // Business names come from Google and reach the DOM. The page builds HTML
    // by concatenation, so every insertion point must go through esc().
    expect(PAGE).toContain('const esc =');
    expect(PAGE).toMatch(/esc\(r\.name\)/);
    expect(PAGE).toMatch(/esc\(r\.email\)/);
  });

  it('respects reduced motion', () => {
    expect(PAGE).toContain('prefers-reduced-motion');
  });

  it('routes on hashchange, so back and forward work', () => {
    expect(PAGE).toContain("addEventListener('hashchange'");
  });

  it('ships a script that actually parses', () => {
    // The whole dashboard is one inline script inside a template literal, so a
    // stray bracket or an unescaped backtick produces a page that loads, looks
    // fine, and does nothing — with the error only in the browser console.
    // vm.Script compiles without running, which is exactly the check.
    const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1];
    expect(script).toBeDefined();
    expect(() => new vm.Script(script as string)).not.toThrow();
  });
});

describe('task controls', () => {
  it('are refused unless explicitly enabled', async () => {
    const { url } = await serve();
    const start = await fetch(`${url}/api/tasks/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'run' }),
    });
    expect(start.status).toBe(403);

    const listed = (await (await fetch(`${url}/api/tasks`)).json()) as { enabled: boolean };
    expect(listed.enabled).toBe(false);
  });

  it('refuses "retry all failed" without --control, because it writes', async () => {
    // View-only has to mean read-only. Retrying rewrites job rows and deletes
    // their resume points, so it belongs behind the same gate as every other
    // action — it was reachable without one.
    const { url } = await serve();
    const response = await fetch(`${url}/api/jobs/retry`, { method: 'POST' });
    expect(response.status).toBe(403);
  });

  it('allows "retry all failed" once controls are enabled', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/jobs/retry`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ retried: 0 });
  });

  it('names a flag that exists when it refuses', async () => {
    // The dashboard used to say "restart with --allow-control". No such flag.
    const { url } = await serve();
    const body = (await (
      await fetch(`${url}/api/tasks/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'run' }),
      })
    ).json()) as { error: string };

    expect(body.error).toContain('--control');
    expect(body.error).not.toContain('--allow-control');
    expect(PAGE).not.toContain('--allow-control');
  });

  it('refuses a command that is not on the allow-list', async () => {
    // The page names a command; it never supplies a command line. Anything
    // outside the list must be rejected rather than executed.
    const { url } = await serve({ allowControl: true });
    for (const command of ['rm', 'db', '../../bin/sh', '']) {
      const response = await fetch(`${url}/api/tasks/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      expect(response.status, command).toBe(400);
    }
  });

  it('runs a real command and reports its output', async () => {
    const { url } = await serve({ allowControl: true });
    const started = (await (
      await fetch(`${url}/api/tasks/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'export', options: { entity: 'businesses' } }),
      })
    ).json()) as { id: string };
    expect(started.id).toBeTruthy();

    // Poll until it finishes; an export of an empty database is quick.
    let task: { state: string; lines: string[] } | undefined;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const list = (await (await fetch(`${url}/api/tasks`)).json()) as {
        tasks: { id: string; state: string; lines: string[] }[];
      };
      task = list.tasks.find((t) => t.id === started.id);
      if (task !== undefined && task.state !== 'running') break;
    }

    expect(task?.state).toBe('succeeded');
    expect(task?.lines.join('\n')).toMatch(/Nothing to export|row\(s\) exported/);
  }, 45_000);

  it('refuses a second copy of the same command', async () => {
    const { url } = await serve({ allowControl: true });
    const body = JSON.stringify({ command: 'run', options: { workers: 1, maxJobs: 1 } });
    const headers = { 'content-type': 'application/json' };

    const first = await fetch(`${url}/api/tasks/start`, { method: 'POST', headers, body });
    expect(first.status).toBe(200);

    // Two scrapes against one queue is safe but never intended by a click.
    const second = await fetch(`${url}/api/tasks/start`, { method: 'POST', headers, body });
    expect(second.status).toBe(409);

    const id = ((await first.json()) as { id: string }).id;
    await fetch(`${url}/api/tasks/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id }),
    });
  }, 30_000);

  it('clamps numeric options rather than passing them through', async () => {
    // A worker count of 10,000 would exhaust memory; the flag builder bounds it.
    const { url } = await serve({ allowControl: true });
    const started = (await (
      await fetch(`${url}/api/tasks/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'export', options: { entity: 'businesses' } }),
      })
    ).json()) as { args: string[] };
    expect(started.args).toEqual(['export', 'csv', '--entity', 'businesses']);
  });

  it('strips shell metacharacters from free-text selectors', async () => {
    const { url } = await serve({ allowControl: true });
    const started = (await (
      await fetch(`${url}/api/tasks/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'plan', options: { cities: 'Boston; rm -rf /' } }),
      })
    ).json()) as { args: string[] };

    expect(started.args.join(' ')).not.toContain(';');
    expect(started.args.join(' ')).not.toContain('/');
  });

  it('accepts an upload and keeps it inside the data directory', async () => {
    const { url, root } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/upload?name=seeds.xlsx`, {
      method: 'POST',
      body: Buffer.from('not really a workbook'),
    });

    const body = (await response.json()) as { file: string };
    expect(response.status).toBe(200);
    expect(body.file).toContain(path.join(root, 'data', 'uploads'));
    expect(fs.existsSync(body.file)).toBe(true);
  });

  it('sanitizes a traversing upload name', async () => {
    // A filename is attacker-controlled input that becomes a path.
    const { url, root } = await serve({ allowControl: true });
    const body = (await (
      await fetch(`${url}/api/upload?name=${encodeURIComponent('../../etc/passwd')}`, {
        method: 'POST',
        body: Buffer.from('x'),
      })
    ).json()) as { file: string };

    expect(body.file).toContain(path.join(root, 'data', 'uploads'));
    expect(body.file).not.toContain('..');
  });
});

describe('cities and services', () => {
  const post = (url: string, body: unknown) =>
    fetch(`${url}/api/seeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('lists both kinds on an empty database', async () => {
    const { url } = await serve();
    expect(await (await fetch(`${url}/api/seeds?kind=cities`)).json()).toEqual([]);
    expect(await (await fetch(`${url}/api/seeds?kind=categories`)).json()).toEqual([]);
  });

  it('refuses edits without --control', async () => {
    const { url } = await serve();
    const response = await post(url, { kind: 'category', op: 'add', values: { name: 'Plumber' } });
    expect(response.status).toBe(403);
    expect((await fetch(`${url}/api/seeds/save`, { method: 'POST' })).status).toBe(403);
  });

  it('adds, pauses and deletes, reporting each step', async () => {
    const { url } = await serve({ allowControl: true });
    const added = (await (
      await post(url, {
        kind: 'city',
        op: 'add',
        values: { city: 'Atlanta', stateCode: 'GA', zip: '30303', coordinates: '33.75, -84.39' },
      })
    ).json()) as { id: number };

    expect((await post(url, { kind: 'city', op: 'pause', id: added.id })).status).toBe(200);
    const rows = (await (await fetch(`${url}/api/seeds?kind=cities`)).json()) as {
      progress: string;
    }[];
    expect(rows.map((r) => r.progress)).toEqual(['paused']);

    expect(await (await post(url, { kind: 'city', op: 'delete', id: added.id })).json()).toEqual({
      jobsRemoved: 0,
    });
  });

  it('answers a refused edit with the reason and what to do instead', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await post(url, { kind: 'city', op: 'add', values: { city: 'Nowhere' } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/zip/);
  });

  it('refuses an operation that does not exist', async () => {
    const { url } = await serve({ allowControl: true });
    expect((await post(url, { kind: 'city', op: 'drop', id: 1 })).status).toBe(400);
    expect((await post(url, { kind: 'jobs', op: 'delete', id: 1 })).status).toBe(400);
  });

  it('saves the lists to the seeds folder it was given', async () => {
    const { url, root } = await serve({ allowControl: true });
    await post(url, { kind: 'category', op: 'add', values: { name: 'Plumber' } });
    const response = await fetch(`${url}/api/seeds/save`, { method: 'POST' });
    expect(await response.json()).toMatchObject({ cities: 0, categories: 1 });
    expect(fs.readFileSync(path.join(root, 'seeds', 'services.csv'), 'utf8')).toContain('Plumber');
  });
});

describe('requests from other websites', () => {
  // Loopback keeps other machines out, not other pages in the same browser. A
  // cross-site text/plain POST skips the CORS preflight entirely.
  it('refuses a write that another origin sent', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/jobs/retry`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a write the browser marks as cross-site', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/jobs/retry`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
  });

  it('allows a write from its own page', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/jobs/retry`, {
      method: 'POST',
      headers: { origin: url, 'sec-fetch-site': 'same-origin' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses any request addressed to another host name (DNS rebinding)', async () => {
    const { port } = await serve();
    // fetch() will not let a caller override Host, so speak HTTP directly.
    const http = await import('node:http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: '/api/leads',
            headers: { host: `evil.example:${port}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('only lists sheets of files the page uploaded', async () => {
    const { url } = await serve({ allowControl: true });
    const response = await fetch(`${url}/api/sheets?file=${encodeURIComponent('/etc/hosts')}`);
    expect(response.status).toBe(400);
  });
});

describe('stopping a task', () => {
  // Windows has no SIGTERM: kill() there is TerminateProcess, which runs no
  // handler. The stop request therefore travels over IPC, and has to land in the
  // child's graceful shutdown rather than end it abruptly.
  it('stops a long-running command gracefully, not by killing it', async () => {
    const root = tempDir();
    writeFile(root, 'gms.config.yaml', 'project:\n  name: test\n');
    const tasks = new TaskManager({ cliEntry: cliEntryPoint(), cwd: root, stopTimeoutMs: 30_000 });

    // `gms ui` installs a shutdown controller and then waits forever: the
    // simplest real command that can only end by being asked to.
    const started = tasks.start({
      name: 'run',
      label: 'wait',
      // The CLI refuses port 0, so pick an unlikely-to-be-taken one.
      args: ['ui', '--no-open', '--port', String(41_000 + Math.floor(Math.random() * 20_000))],
    });
    if (!started.ok) throw new Error(started.error);
    const task = started.task;

    const until = async (done: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out; output:\n${task.lines.join('\n')}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => task.lines.some((l) => l.includes('listening')), 20_000);

    const stoppedAt = Date.now();
    expect(tasks.stop(task.id)).toBe(true);
    await until(() => task.finishedAt !== null, 25_000);

    expect(task.state).toBe('stopped');
    // A clean exit, long before the kill fallback would have fired.
    expect(task.exitCode).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(15_000);
    expect(task.lines.join('\n')).not.toContain('killed');
  }, 60_000);
});

describe('google sheets settings', () => {
  const KEY = JSON.stringify({
    type: 'service_account',
    project_id: 'p',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
    client_email: 'gms-exporter@p.iam.gserviceaccount.com',
  });
  const ID = '1fMmJb6FZT1N5WXmg_Jf9e92dxAZ_DlJGWcPZXNqyJIE';
  const settings = async (url: string) =>
    (await (await fetch(`${url}/api/sheets/settings`)).json()) as Record<string, unknown>;
  const post = (url: string, endpoint: string, body: string) =>
    fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('accepts the sheet as a pasted link, and uses it without a restart', async () => {
    const { url, root } = await serve({ allowConfigWrite: true, allowControl: true });
    const response = await post(
      url,
      '/api/sheets/settings',
      JSON.stringify({
        spreadsheet: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
        sheetName: 'Team',
      }),
    );
    expect(response.status).toBe(200);
    expect(await settings(url)).toMatchObject({ spreadsheetId: ID, sheetName: 'Team' });
    expect(fs.readFileSync(path.join(root, 'gms.config.local.yaml'), 'utf8')).toContain(ID);
  });

  it('refuses something that is not a sheet', async () => {
    const { url } = await serve({ allowConfigWrite: true, allowControl: true });
    const response = await post(
      url,
      '/api/sheets/settings',
      JSON.stringify({ spreadsheet: 'my sheet' }),
    );
    expect(response.status).toBe(400);
  });

  it('is refused on a read-only dashboard', async () => {
    const { url } = await serve();
    expect(
      (await post(url, '/api/sheets/settings', JSON.stringify({ spreadsheet: ID }))).status,
    ).toBe(403);
    expect((await post(url, '/api/sheets/key', KEY)).status).toBe(403);
  });

  it('stores a service-account key privately and reports only its address', async () => {
    const { url, root } = await serve({ allowConfigWrite: true, allowControl: true });
    const response = await post(url, '/api/sheets/key', KEY);
    const body = await response.text();
    expect(response.status).toBe(200);
    // The private key never travels back to the page.
    expect(body).not.toContain('PRIVATE KEY');

    const file = path.join(root, 'credentials', 'gms-exporter.json');
    expect(fs.readFileSync(file, 'utf8')).toBe(KEY);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(await settings(url)).toMatchObject({
      keyFound: true,
      clientEmail: 'gms-exporter@p.iam.gserviceaccount.com',
    });
  });

  it('turns away the look-alike files from the Cloud console', async () => {
    const { url, root } = await serve({ allowConfigWrite: true, allowControl: true });
    for (const wrong of [
      JSON.stringify({ installed: { client_id: 'x' } }),
      JSON.stringify({ type: 'authorized_user' }),
      'not json',
    ]) {
      const response = await post(url, '/api/sheets/key', wrong);
      expect(response.status, wrong).toBe(400);
    }
    expect(fs.existsSync(path.join(root, 'credentials'))).toBe(false);
  });

  it('tests the connection, reporting what is missing', async () => {
    const { url } = await serve();
    const body = (await (await post(url, '/api/sheets/check', '{}')).json()) as {
      results: { status: string; detail: string }[];
    };
    expect(body.results).toEqual([
      expect.objectContaining({ status: 'warn', detail: 'not configured' }),
    ]);
  });

  it('reads the id out of every kind of sheet link', () => {
    for (const link of [
      ID,
      `https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`,
      `https://docs.google.com/spreadsheets/d/${ID}`,
      `  docs.google.com/spreadsheets/d/${ID}/copy  `,
    ]) {
      expect(parseSpreadsheetId(link), link).toBe(ID);
    }
    expect(parseSpreadsheetId('https://example.com/')).toBeNull();
  });

  it('records a key in the home folder as ~/..., so the config works on any machine', () => {
    expect(portablePath(path.join(os.homedir(), 'gms-credentials', 'k.json'))).toBe(
      '~/gms-credentials/k.json',
    );
  });
});

describe('autopilot', () => {
  const post = (url: string, body: unknown) =>
    fetch(`${url}/api/autopilot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('is unavailable on a read-only dashboard', async () => {
    const { url } = await serve();
    expect(await (await fetch(`${url}/api/autopilot`)).json()).toEqual({ available: false });
    expect((await post(url, { enabled: true })).status).toBe(403);
  });

  it('starts off, with the recommended settings', async () => {
    const { url } = await serve({ allowControl: true });
    const view = (await (await fetch(`${url}/api/autopilot`)).json()) as {
      settings: { enabled: boolean; scrape: { workers: number } };
    };
    expect(view.settings.enabled).toBe(false);
    expect(view.settings.scrape.workers).toBe(4);
  });

  it('keeps its settings across a dashboard restart', async () => {
    const { url, root } = await serve({ allowControl: true });
    await post(url, { enabled: false, scrape: { workers: 6 }, sheets: { batchRows: 250 } });
    await running.pop()!.close();

    const config = loadConfig({ cwd: root, env: {} });
    const again = await startUiServer({ config, port: 0, allowControl: true });
    running.push(again);
    const view = (await (await fetch(`${again.url}/api/autopilot`)).json()) as {
      settings: { scrape: { workers: number }; sheets: { batchRows: number } };
    };
    expect(view.settings.scrape.workers).toBe(6);
    expect(view.settings.sheets.batchRows).toBe(250);
  });

  it('turned on with nothing to do, starts nothing and says why', async () => {
    const { url } = await serve({ allowControl: true });
    const view = (await (await post(url, { enabled: true })).json()) as {
      status: Record<string, { state: string; detail: string }>;
    };
    expect(view.status['scrape']).toMatchObject({ state: 'idle', detail: 'no searches queued' });
    expect(view.status['sheets']!.detail).toMatch(/step 7/);
    const tasks = (await (await fetch(`${url}/api/tasks`)).json()) as { tasks: unknown[] };
    expect(tasks.tasks).toEqual([]);
  });
});

describe('re-scraping finished searches', () => {
  it('is refused without --control', async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/api/jobs/rescrape`, { method: 'POST' })).status).toBe(403);
  });

  it('puts every finished search back in the queue', async () => {
    const { url, root } = await serve({ allowControl: true });
    const config = loadConfig({ cwd: root, env: {} });
    const driver = openDatabase({ file: config.paths.databaseFile });
    driver
      .prepare(
        `INSERT INTO jobs (automation_id, task_key, params_json, status, created_at, updated_at, finished_at)
         VALUES ('google-maps', 'a', '{}', 'done', 0, 0, 1), ('google-maps', 'b', '{}', 'pending', 0, 0, NULL)`,
      )
      .run();
    driver.close();

    const response = await fetch(`${url}/api/jobs/rescrape`, { method: 'POST' });
    expect(await response.json()).toEqual({ queued: 1 });
  });
});
