import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, resolvePath, safeSegment } from '../src/core/util/paths.js';

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('expands a tilde prefix', () => {
    expect(expandHome('~/gms')).toBe(path.join(os.homedir(), 'gms'));
  });

  it('leaves a tilde in the middle of a path alone', () => {
    expect(expandHome('/tmp/~backup')).toBe('/tmp/~backup');
  });
});

describe('resolvePath', () => {
  it('resolves a relative path against the given base, not process.cwd()', () => {
    expect(resolvePath('./data', '/projects/gms')).toBe(path.resolve('/projects/gms', 'data'));
  });

  it('leaves an absolute path unchanged apart from normalization', () => {
    const absolute = path.resolve('/var/lib/gms');
    expect(resolvePath(absolute, '/somewhere/else')).toBe(absolute);
  });
});

describe('safeSegment', () => {
  it('strips characters Windows forbids in filenames', () => {
    expect(safeSegment('Bob<>:"/\\|?*Smith')).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('collapses whitespace into single hyphens', () => {
    expect(safeSegment("Joe's  Plumbing   LLC")).toBe("Joe's-Plumbing-LLC");
  });

  it('truncates long names so full paths stay clear of the Windows limit', () => {
    expect(safeSegment('a'.repeat(500)).length).toBeLessThanOrEqual(64);
  });

  it('escapes Windows reserved device names', () => {
    for (const reserved of ['con', 'PRN', 'aux', 'NUL', 'com1', 'LPT9']) {
      expect(safeSegment(reserved)).toMatch(/^_/);
    }
  });

  it('never returns an empty string', () => {
    expect(safeSegment('///').length).toBeGreaterThan(0);
    expect(safeSegment('').length).toBeGreaterThan(0);
  });

  it('preserves non-Latin business names rather than emptying them', () => {
    expect(safeSegment('東京すし')).toBe('東京すし');
  });
});
