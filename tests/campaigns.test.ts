/**
 * Campaigns: a second, independent set of config, lists and database under
 * `campaigns/<name>/`, selected with `--campaign <name>`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { campaignDir, packageRoot } from '../src/core/util/paths.js';
import { bundledSeedsDir } from '../src/seeds/bundled.js';
import { brandPage } from '../src/ui/server.js';
import { KEY_FILE_NAME, keyFileName } from '../src/ui/sheets.js';
import { keepAwakeWhile } from '../src/ui/tasks.js';
import { buildProgram } from '../src/cli/main.js';
import type { ChildProcess } from 'node:child_process';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

afterEach(cleanupTempDirs);

describe('campaign folders', () => {
  it('resolves a campaign under the package, whatever the working directory', () => {
    expect(campaignDir('gobadiz')).toBe(path.join(packageRoot(), 'campaigns', 'gobadiz'));
    expect(fs.existsSync(path.join(packageRoot(), 'package.json'))).toBe(true);
  });

  it('refuses a name that is a path, so --campaign cannot leave campaigns/', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '', '.hidden', 'C:\\x']) {
      expect(() => campaignDir(bad)).toThrow(/not a campaign name/);
    }
  });

  it('ships the gobadiz campaign with its own data dir, lists and port', () => {
    const config = loadConfig({ cwd: campaignDir('gobadiz'), env: {} });
    expect(config.project.name).toBe('gobadiz');
    expect(config.paths.root).toBe(campaignDir('gobadiz'));
    expect(config.paths.dataDir).toBe(path.join(campaignDir('gobadiz'), 'data'));
    expect(config.paths.seedsDir).toBe(path.join(campaignDir('gobadiz'), 'seeds'));
    expect(config.ui.port).not.toBe(4600);
  });
});

describe('seeds.dir', () => {
  it('defaults to the bundled seeds/ folder, so the main campaign is unchanged', () => {
    const config = loadConfig({ cwd: tempDir(), env: {} });
    expect(config.paths.seedsDir).toBe(bundledSeedsDir());
    expect(config.ui.port).toBe(4600);
  });

  it('resolves against the config file, not the shell', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'seeds:\n  dir: ./lists\n');
    expect(loadConfig({ cwd: dir, env: {} }).paths.seedsDir).toBe(path.join(dir, 'lists'));
  });
});

describe('--campaign', () => {
  it('is refused together with --config', async () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    await expect(
      program.parseAsync([
        'node',
        'gms',
        '--campaign',
        'gobadiz',
        '-c',
        'x.yaml',
        'config',
        'show',
      ]),
    ).rejects.toThrow(/--campaign or --config/);
  });

  it('names a campaign that does not exist', async () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    await expect(
      program.parseAsync(['node', 'gms', '--campaign', 'nope', 'config', 'show']),
    ).rejects.toThrow(/no campaign "nope"/);
  });
});

describe('dashboard branding', () => {
  const html = '<title>gms · sweep</title><div class="brand">gms<span>.</span>';

  it('leaves the main campaign page untouched', () => {
    expect(brandPage(html, 'gms')).toBe(html);
  });

  it('names a campaign in the tab title and sidebar, escaped', () => {
    const branded = brandPage(html, 'gobadiz<x>');
    expect(branded).toContain('<title>gobadiz&#60;x&#62; · sweep</title>');
    expect(branded).toContain('<div class="brand">gobadiz&#60;x&#62;<span>');
  });
});

describe('sheets key file per campaign', () => {
  it('keeps the original name for the main campaign', () => {
    expect(keyFileName('gms')).toBe(KEY_FILE_NAME);
  });

  it('gives a campaign its own file, so uploads cannot overwrite each other', () => {
    expect(keyFileName('gobadiz')).toBe('gobadiz-exporter.json');
    expect(keyFileName('Mon Projet!')).toBe('mon-projet-exporter.json');
  });
});

describe('keeping a Mac awake during a task', () => {
  it('does nothing off macOS', () => {
    const child = { pid: 123 } as unknown as ChildProcess;
    expect(keepAwakeWhile(child, 'win32')).toBeNull();
    expect(keepAwakeWhile(child, 'linux')).toBeNull();
  });

  it('does nothing for a child that never started', () => {
    const child = { pid: undefined } as unknown as ChildProcess;
    expect(keepAwakeWhile(child, 'darwin')).toBeNull();
  });
});
