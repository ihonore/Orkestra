/**
 * Cross-platform path helpers.
 *
 * Every path in this project is built here or with `node:path`. String
 * concatenation of path fragments is a lint error — it is the single most common
 * source of Windows breakage.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Expand a leading `~` to the user's home directory. Does nothing to other paths. */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolve a user-supplied path to an absolute one.
 *
 * Relative paths resolve against `baseDir` (normally the project root) rather
 * than `process.cwd()`, so a config file means the same thing regardless of
 * which directory the CLI was invoked from.
 */
export function resolvePath(input: string, baseDir: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

/** Directory of the module that calls this, given its `import.meta.url`. */
export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Display form of a path: forward slashes, home collapsed to `~`.
 * For log lines and CLI output only — never feed this back into the filesystem.
 */
export function displayPath(input: string): string {
  const home = os.homedir();
  const collapsed =
    home && input.startsWith(home) ? path.join('~', input.slice(home.length)) : input;
  return collapsed.split(path.sep).join('/');
}

/**
 * Make an arbitrary string safe to use as a single path segment.
 *
 * Google Maps business names are long and routinely contain emoji, CJK, slashes
 * and reserved Windows characters, so anything derived from scraped text goes
 * through here before it touches the filesystem. `maxLength` keeps whole paths
 * clear of the 260-char limit that Windows tooling still enforces.
 */
export function safeSegment(input: string, maxLength = 64): string {
  const cleaned = input
    // Reserved on Windows, plus control characters. Stripping control
    // characters is precisely the intent here, so the rule against
    // matching them does not apply.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxLength);
  // Windows forbids these device names regardless of extension.
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (cleaned === '' || reserved.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}
