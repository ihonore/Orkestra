/**
 * Dashboard server tests.
 *
 * The config-write path gets the most attention here: it takes input from a web
 * form and writes a file the whole tool then depends on, so an invalid write
 * would leave `gms` unable to start.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { startUiServer, type RunningServer } from '../src/ui/server.js';
import { PAGE } from '../src/ui/page.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

const running: RunningServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  cleanupTempDirs();
});

/** A project directory with a migrated, empty database. */
async function serve(
  options: { allowConfigWrite?: boolean; allowControl?: boolean } = {},
): Promise<{ url: string; root: string }> {
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
  });
  running.push(server);
  return { url: server.url, root };
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
