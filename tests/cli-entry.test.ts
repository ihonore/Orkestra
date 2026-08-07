import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isEntryPoint } from '../src/cli/main.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/**
 * These guard a failure mode with no symptom: when entry detection is wrong,
 * `gms` exits 0 having printed nothing at all. It looks like the command ran.
 */
describe('CLI entry detection', () => {
  it('recognises the module when run directly', () => {
    const file = path.join(tempDir(), 'main.js');
    fs.writeFileSync(file, '');
    expect(isEntryPoint(file, pathToFileURL(file).href)).toBe(true);
  });

  it('recognises the module when run through a symlink', () => {
    // This is how every npm `bin` is installed. Comparing paths unresolved
    // fails here, and the CLI silently does nothing.
    const dir = tempDir();
    const real = path.join(dir, 'main.js');
    const link = path.join(dir, 'gms');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, link);

    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
  });

  it('recognises a symlink chain, as nvm plus npm link produces', () => {
    const dir = tempDir();
    const real = path.join(dir, 'main.js');
    const middle = path.join(dir, 'installed');
    const link = path.join(dir, 'gms');
    fs.writeFileSync(real, '');
    fs.symlinkSync(real, middle);
    fs.symlinkSync(middle, link);

    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
  });

  it('does not fire when the module is merely imported', () => {
    // Importing buildProgram() from a test must not start the CLI.
    const dir = tempDir();
    const module = path.join(dir, 'main.js');
    const other = path.join(dir, 'some-test-runner.js');
    fs.writeFileSync(module, '');
    fs.writeFileSync(other, '');

    expect(isEntryPoint(other, pathToFileURL(module).href)).toBe(false);
  });

  it('handles a path containing spaces', () => {
    // The project itself lives in "Coding Projects".
    const dir = path.join(tempDir(), 'Coding Projects');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.js');
    fs.writeFileSync(file, '');

    expect(isEntryPoint(file, pathToFileURL(file).href)).toBe(true);
  });

  it('returns false rather than throwing on a non-path entry', () => {
    // `node -e` leaves argv[1] undefined; a virtual entry may not resolve.
    expect(isEntryPoint(undefined, 'file:///x/main.js')).toBe(false);
    expect(isEntryPoint('', 'file:///x/main.js')).toBe(false);
    expect(isEntryPoint('/does/not/exist', 'file:///x/main.js')).toBe(false);
  });

  it('falls back to the raw path when resolution fails', () => {
    const thrower = (): string => {
      throw new Error('ENOENT');
    };
    expect(isEntryPoint('/virtual/main.js', 'file:///virtual/main.js', thrower)).toBe(true);
  });
});

describe('packaging', () => {
  it('declares a bin that matches the build output', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { bin?: Record<string, string>; files?: string[]; scripts?: Record<string, string> };

    expect(pkg.bin?.['gms']).toBe('./dist/cli/main.js');
    // migrations/ is read at runtime from outside dist, so it must be packaged.
    expect(pkg.files).toContain('migrations');
    expect(pkg.files).toContain('dist');
  });

  it('restores the executable bit after a build', () => {
    // tsc rewrites the entry file and drops the bit, so `gms` stops working
    // after any rebuild unless postbuild puts it back.
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.['postbuild']).toMatch(/chmodSync/);
  });

  it('keeps the shebang on the entry file', () => {
    const source = fs.readFileSync(new URL('../src/cli/main.ts', import.meta.url), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
