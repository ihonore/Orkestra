import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { hashConfig, loadConfig } from '../src/config/loader.js';
import { readEnvLayer } from '../src/config/env.js';
import { REDACTED, redactSecrets } from '../src/config/redact.js';
import { isAppError } from '../src/core/errors/taxonomy.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

afterEach(cleanupTempDirs);

describe('config defaults', () => {
  it('produces a fully populated config with no files or env', () => {
    const config = loadConfig({ cwd: tempDir(), env: {} });

    expect(config.project.name).toBe('gms');
    expect(config.database.driver).toBe('sqlite');
    expect(config.database.wal).toBe(true);
    expect(config.logging.level).toBe('info');
    // Nested defaults must apply even though no section was supplied at all.
    expect(config.database.synchronous).toBe('NORMAL');
    expect(config.logging.redact).toEqual([]);
  });

  it('keeps the busy timeout short, because the busy handler blocks the event loop', () => {
    const config = loadConfig({ cwd: tempDir(), env: {} });
    expect(config.database.busyTimeoutMs).toBeLessThanOrEqual(250);
  });
});

describe('config layering', () => {
  it('applies precedence: file < local file < env < flags', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'logging:\n  level: warn\nproject:\n  name: from-file\n');
    writeFile(dir, 'gms.config.local.yaml', 'logging:\n  level: debug\n');

    const config = loadConfig({
      cwd: dir,
      env: { GMS_LOGGING__LEVEL: 'error' },
      overrides: { logging: { level: 'trace' } },
    });

    expect(config.logging.level).toBe('trace');
    // A key set only by the base file survives all the higher layers.
    expect(config.project.name).toBe('from-file');
  });

  it('lets the local file override the committed one', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'project:\n  name: committed\n');
    writeFile(dir, 'gms.config.local.yaml', 'project:\n  name: local\n');

    expect(loadConfig({ cwd: dir, env: {} }).project.name).toBe('local');
  });

  it('merges nested objects rather than replacing whole sections', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'database:\n  file: custom.sqlite\n');

    const config = loadConfig({ cwd: dir, env: { GMS_DATABASE__WAL: 'false' } });

    expect(config.database.file).toBe('custom.sqlite');
    expect(config.database.wal).toBe(false);
    // Untouched sibling keys keep their defaults.
    expect(config.database.synchronous).toBe('NORMAL');
  });

  it('records which layers contributed', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'project:\n  name: x\n');

    const kinds = loadConfig({ cwd: dir, env: { GMS_LOGGING__LEVEL: 'warn' } }).sources.map(
      (s) => s.kind,
    );

    expect(kinds).toEqual(['defaults', 'file', 'env']);
  });
});

describe('config validation', () => {
  it('rejects an unknown key instead of silently ignoring it', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'projcet:\n  name: typo\n');

    expect(() => loadConfig({ cwd: dir, env: {} })).toThrowError(/Invalid configuration/);
  });

  it('reports the offending field path', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'logging:\n  level: verbose\n');

    try {
      loadConfig({ cwd: dir, env: {} });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as Error).message).toContain('logging.level');
    }
  });

  it('rejects a busy timeout large enough to stall the event loop', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'database:\n  busyTimeoutMs: 30000\n');

    expect(() => loadConfig({ cwd: dir, env: {} })).toThrowError(/busyTimeoutMs/);
  });

  it('fails loudly on malformed YAML', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'project:\n\tname: tabs-are-invalid\n');

    expect(() => loadConfig({ cwd: dir, env: {} })).toThrowError(/not valid YAML|Invalid/);
  });

  it('throws when an explicitly requested config file is missing', () => {
    const dir = tempDir();
    expect(() => loadConfig({ cwd: dir, configFile: 'nope.yaml', env: {} })).toThrowError(
      /not found/,
    );
  });
});

describe('path resolution', () => {
  it('resolves dataDir against the config file, not the shell cwd', () => {
    const dir = tempDir();
    writeFile(dir, 'gms.config.yaml', 'project:\n  dataDir: ./state\n');

    const config = loadConfig({ cwd: dir, env: {} });

    expect(config.paths.dataDir).toBe(path.join(dir, 'state'));
    expect(config.paths.databaseFile).toBe(path.join(dir, 'state', 'gms.sqlite'));
  });

  it('places logs, artifacts and exports under the data directory', () => {
    const config = loadConfig({ cwd: tempDir(), env: {} });

    expect(config.paths.logsDir).toBe(path.join(config.paths.dataDir, 'logs'));
    expect(config.paths.artifactsDir).toBe(path.join(config.paths.dataDir, 'artifacts'));
    expect(config.paths.exportsDir).toBe(path.join(config.paths.dataDir, 'exports'));
  });
});

describe('environment layer', () => {
  it('maps SNAKE_CASE segments to camelCase paths', () => {
    const { values } = readEnvLayer({ GMS_DATABASE__BUSY_TIMEOUT_MS: '500' });
    expect(values).toEqual({ database: { busyTimeoutMs: 500 } });
  });

  it('coerces JSON-looking values but leaves plain strings alone', () => {
    const { values } = readEnvLayer({
      GMS_DATABASE__WAL: 'false',
      GMS_LOGGING__LEVEL: 'debug',
      GMS_LOGGING__REDACT: '["a.b"]',
      GMS_PROJECT__NAME: '123-abc',
    });

    expect(values).toEqual({
      database: { wal: false },
      logging: { level: 'debug', redact: ['a.b'] },
      project: { name: '123-abc' },
    });
  });

  it('ignores variables without the GMS_ prefix', () => {
    expect(readEnvLayer({ PATH: '/usr/bin', HOME: '/root' }).names).toEqual([]);
  });
});

describe('config hash', () => {
  it('is stable regardless of key order', () => {
    expect(hashConfig({ a: 1, b: { c: 2, d: 3 } })).toBe(hashConfig({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when a value changes', () => {
    expect(hashConfig({ a: 1 })).not.toBe(hashConfig({ a: 2 }));
  });

  it('is identical for two configs that differ only in where they live', () => {
    const a = loadConfig({ cwd: tempDir(), env: {} });
    const b = loadConfig({ cwd: tempDir(), env: {} });
    expect(a.hash).toBe(b.hash);
  });
});

describe('redaction', () => {
  it('masks secret paths without mutating the input', () => {
    const input = { proxy: { gateway: { password: 'hunter2', server: 'gw:7777' } } };
    const output = redactSecrets(input);

    expect(output.proxy.gateway.password).toBe(REDACTED);
    expect(output.proxy.gateway.server).toBe('gw:7777');
    expect(input.proxy.gateway.password).toBe('hunter2');
  });

  it('leaves values alone when no secret path matches', () => {
    const input = { project: { name: 'gms' } };
    expect(redactSecrets(input)).toEqual(input);
  });
});
