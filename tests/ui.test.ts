/**
 * Dashboard server tests.
 *
 * The config-write path gets the most attention here: it takes input from a web
 * form and writes a file the whole tool then depends on, so an invalid write
 * would leave `gms` unable to start.
 */
import fs from 'node:fs';
import path from 'node:path';
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
async function serve(options: { allowConfigWrite?: boolean } = {}): Promise<{
  url: string;
  root: string;
}> {
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
});
