import { describe, expect, it } from 'vitest';
import { assertSafeDatabasePath, assessStoragePath } from '../src/core/util/storage-safety.js';

describe('network filesystem detection', () => {
  it('flags a Windows UNC path', () => {
    const result = assessStoragePath('\\\\fileserver\\share\\gms\\gms.sqlite', 'win32');
    expect(result.risk).toBe('network');
    expect(result.detail).toMatch(/UNC/);
  });

  it('flags the forward-slash form of a UNC path', () => {
    expect(assessStoragePath('//fileserver/share/gms.sqlite', 'win32').risk).toBe('network');
  });

  it('does not flag a leading double slash on POSIX, where it is a legal path', () => {
    expect(assessStoragePath('//home/ihonore/gms.sqlite', 'linux').risk).toBe('safe');
  });

  it('flags Linux network mount points', () => {
    expect(assessStoragePath('/net/nas/gms.sqlite', 'linux').risk).toBe('network');
    expect(assessStoragePath('/run/user/1000/gvfs/smb-share/gms.sqlite', 'linux').risk).toBe(
      'network',
    );
  });

  it('does not flag /Volumes on macOS, where external disks also live', () => {
    expect(assessStoragePath('/Volumes/BigDisk/gms.sqlite', 'darwin').risk).toBe('safe');
  });
});

describe('cloud-sync detection', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['/Users/x/OneDrive/gms/gms.sqlite', 'OneDrive'],
    ['/Users/x/OneDrive - Contoso/gms.sqlite', 'OneDrive'],
    ['C:\\Users\\x\\Dropbox\\gms.sqlite', 'Dropbox'],
    ['/Users/x/Google Drive/gms.sqlite', 'Google Drive'],
    ['/Users/x/Library/Mobile Documents/com~apple~CloudDocs/gms.sqlite', 'iCloud Drive'],
    ['/Users/x/Nextcloud/gms.sqlite', 'Nextcloud'],
  ];

  for (const [input, provider] of cases) {
    it(`flags ${provider} at ${input}`, () => {
      const result = assessStoragePath(input, 'darwin');
      expect(result.risk).toBe('cloud-sync');
      expect(result.detail).toContain(provider);
    });
  }

  it('does not flag an ordinary local path', () => {
    expect(assessStoragePath('/Users/x/Coding/gms/data/gms.sqlite', 'darwin').risk).toBe('safe');
  });

  it('does not flag a directory that merely contains a provider name as a substring', () => {
    // "Dropboxes" is not "Dropbox" — matching is per whole segment.
    expect(assessStoragePath('/Users/x/Dropboxes/gms.sqlite', 'darwin').risk).toBe('safe');
  });
});

describe('assertSafeDatabasePath', () => {
  it('refuses a network path unconditionally, even with the override set', () => {
    expect(() =>
      assertSafeDatabasePath('\\\\server\\share\\gms.sqlite', { allowCloudSync: true }),
    ).toThrowError(/network filesystem/);
  });

  it('refuses a cloud-synced path by default', () => {
    const cloudPath =
      process.platform === 'win32'
        ? 'C:\\Users\\x\\Dropbox\\gms.sqlite'
        : '/Users/x/Dropbox/gms.sqlite';
    expect(() => assertSafeDatabasePath(cloudPath)).toThrowError(/synced folder/);
  });

  it('allows a cloud-synced path when explicitly permitted', () => {
    const cloudPath =
      process.platform === 'win32'
        ? 'C:\\Users\\x\\Dropbox\\gms.sqlite'
        : '/Users/x/Dropbox/gms.sqlite';
    expect(assertSafeDatabasePath(cloudPath, { allowCloudSync: true }).risk).toBe('cloud-sync');
  });

  it('carries an actionable hint explaining why', () => {
    try {
      assertSafeDatabasePath('\\\\server\\share\\gms.sqlite');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/local disk/);
    }
  });
});
