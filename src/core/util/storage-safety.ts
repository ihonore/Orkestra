/**
 * Storage location safety for the SQLite database.
 *
 * Two distinct hazards, often conflated. They are not the same and the wording
 * matters, because the mitigation differs:
 *
 *  1. Network filesystems (UNC paths, mapped drives, NFS/SMB mounts).
 *     SQLite states plainly that WAL "does not work over a network filesystem",
 *     because it requires processes to share memory on one host. Advisory locks
 *     on network filesystems are also widely buggy. This corrupts the LIVE
 *     database, so it is refused outright.
 *
 *  2. Cloud-sync folders (OneDrive, Dropbox, iCloud, Google Drive).
 *     These are ordinary local filesystems, so WAL itself works fine — the claim
 *     "WAL is broken on OneDrive" is not what the SQLite docs say. The real
 *     hazard is that a background sync agent copies the file mid-transaction and
 *     uploads `-wal` / `-shm` independently of the main file, which yields
 *     corrupt COPIES and can clobber the live file on a conflict resolve.
 *     Refused by default, overridable for someone who knowingly accepts it.
 *
 * @see https://www.sqlite.org/wal.html
 * @see https://www.sqlite.org/howtocorrupt.html
 * @see https://www.sqlite.org/useovernet.html
 */
import path from 'node:path';
import { DatabaseError } from '../errors/taxonomy.js';
import { displayPath } from './paths.js';

export type StorageRisk = 'safe' | 'cloud-sync' | 'network';

export interface StorageAssessment {
  readonly risk: StorageRisk;
  readonly path: string;
  /** Which rule matched, phrased for a user. Absent when `risk` is 'safe'. */
  readonly detail?: string;
}

interface SyncProvider {
  readonly name: string;
  /** Matched case-insensitively against individual path segments. */
  readonly segment: RegExp;
}

const SYNC_PROVIDERS: readonly SyncProvider[] = [
  // "OneDrive", "OneDrive - Contoso"
  { name: 'OneDrive', segment: /^onedrive(\s+-\s+.+)?$/i },
  { name: 'Dropbox', segment: /^dropbox(\s+\(.+\))?$/i },
  { name: 'Google Drive', segment: /^(google ?drive|googledrive|my drive|drivefs)$/i },
  // macOS iCloud Drive lives under ~/Library/Mobile Documents/com~apple~CloudDocs
  { name: 'iCloud Drive', segment: /^(mobile documents|com~apple~clouddocs)$/i },
  { name: 'Box', segment: /^box( sync)?$/i },
  { name: 'pCloud', segment: /^pclouddrive$/i },
  { name: 'Nextcloud', segment: /^next ?cloud$/i },
  { name: 'ownCloud', segment: /^own ?cloud$/i },
  { name: 'MEGA', segment: /^mega(sync)?$/i },
  { name: 'Tresorit', segment: /^tresorit$/i },
  { name: 'Seafile', segment: /^seafile$/i },
  { name: 'Yandex.Disk', segment: /^yandex\.?disk$/i },
  { name: 'Creative Cloud Files', segment: /^creative cloud files$/i },
  { name: 'Sync.com', segment: /^sync(\.com)?$/i },
];

/**
 * Detect a UNC path (`\\server\share\...`) or its forward-slash form.
 *
 * Two subtleties, both learned the hard way:
 *
 *  - This must run against the *raw* input. `path.normalize` on POSIX collapses
 *    a leading `//` to `/`, which erases the evidence before it can be checked.
 *
 *  - The backslash form is flagged on every platform, because `\\host\share` is
 *    never a meaningful POSIX path — if it appears, it came from a Windows
 *    config being read somewhere else, and it is still wrong. The forward-slash
 *    form is only flagged for Windows, since a leading `//` is legal on POSIX.
 */
function isUncPath(input: string, platform: NodeJS.Platform): boolean {
  if (/^\\\\[^\\/]/.test(input)) return true;
  return platform === 'win32' && /^\/\/[^/]/.test(input);
}

/**
 * Network mount points that are detectable from the path string alone.
 *
 * A Windows *mapped drive letter* (`Z:` pointing at a share) is deliberately not
 * detected here — the drive letter is indistinguishable from a local disk
 * without a Win32 call, and shelling out to `net use` inside a hot path is not
 * worth it. `gms doctor` states this limitation explicitly so the user can check.
 */
function networkMountDetail(segments: readonly string[], platform: NodeJS.Platform): string | null {
  // macOS is intentionally absent: Finder mounts network shares under /Volumes,
  // but so are ordinary external disks and disk images. Flagging /Volumes would
  // produce false positives far more often than true ones.
  if (platform === 'linux') {
    const [first, second] = segments;
    if (first === 'net' || (first === 'mnt' && second === 'nfs')) {
      return 'path is under a network mount point';
    }
    if (first === 'run' && second === 'user' && segments[3] === 'gvfs') {
      return 'path is inside a GVFS network mount';
    }
  }
  return null;
}

/** Classify where a database file would live. Pure — performs no filesystem I/O. */
export function assessStoragePath(
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): StorageAssessment {
  // Checked before normalization: on POSIX, normalize() collapses a leading
  // `//` to `/` and would hide a UNC path from this test.
  if (isUncPath(absolutePath, platform)) {
    return {
      risk: 'network',
      path: absolutePath,
      detail: 'path is a UNC network share (\\\\server\\share)',
    };
  }

  const normalized = path.normalize(absolutePath);

  const segments = normalized.split(/[\\/]+/).filter((s) => s !== '' && !/^[A-Za-z]:$/.test(s));

  const mountDetail = networkMountDetail(segments, platform);
  if (mountDetail !== null) {
    return { risk: 'network', path: normalized, detail: mountDetail };
  }

  for (const segment of segments) {
    for (const provider of SYNC_PROVIDERS) {
      if (provider.segment.test(segment)) {
        return {
          risk: 'cloud-sync',
          path: normalized,
          detail: `path is inside a ${provider.name} synced folder`,
        };
      }
    }
  }

  return { risk: 'safe', path: normalized };
}

export interface AssertSafeOptions {
  /** Allow a cloud-sync location. Never allows a network filesystem. */
  readonly allowCloudSync?: boolean;
}

/**
 * Throw unless the database may safely live at `absolutePath`.
 *
 * Network locations are unconditionally refused: there is no override, because
 * the failure mode is silent corruption of the live database rather than a
 * degraded-but-working setup.
 */
export function assertSafeDatabasePath(
  absolutePath: string,
  options: AssertSafeOptions = {},
): StorageAssessment {
  const assessment = assessStoragePath(absolutePath);

  if (assessment.risk === 'network') {
    throw new DatabaseError(
      `Refusing to use a database on a network filesystem: ${assessment.detail}.`,
      {
        code: 'DB_PATH_UNSAFE',
        hint:
          `Move the database to a local disk and set database.file accordingly.\n` +
          `SQLite's write-ahead log requires shared memory between processes on one host, ` +
          `so it cannot work over a network filesystem — using one risks corrupting the database.`,
        details: { path: displayPath(assessment.path), risk: assessment.risk },
      },
    );
  }

  if (assessment.risk === 'cloud-sync' && options.allowCloudSync !== true) {
    throw new DatabaseError(
      `Refusing to use a database in a synced folder: ${assessment.detail}.`,
      {
        code: 'DB_PATH_UNSAFE',
        hint:
          `Move the database outside the synced folder, or set database.allowCloudSync: true ` +
          `if you accept the risk.\n` +
          `Sync agents copy files mid-transaction and upload the -wal and -shm sidecars ` +
          `independently of the main file, which produces corrupt copies and can overwrite ` +
          `the live database when resolving a conflict.`,
        details: { path: displayPath(assessment.path), risk: assessment.risk },
      },
    );
  }

  return assessment;
}
