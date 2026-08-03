/**
 * Terminal output helpers.
 *
 * Deliberately dependency-free. Colour is disabled when output is piped or when
 * NO_COLOR is set, so redirected output stays free of escape codes.
 */

const colorEnabled =
  process.env['NO_COLOR'] === undefined &&
  process.env['TERM'] !== 'dumb' &&
  process.stdout.isTTY === true;

/**
 * Legacy Windows consoles (conhost without Windows Terminal) render box-drawing
 * and check marks as mojibake. Windows Terminal sets WT_SESSION; VS Code sets
 * TERM_PROGRAM. Anything else on win32 gets ASCII.
 */
const unicodeEnabled =
  process.platform !== 'win32' ||
  process.env['WT_SESSION'] !== undefined ||
  process.env['TERM_PROGRAM'] !== undefined;

const ESC = '\u001b[';

function wrap(code: number, close: number) {
  return (text: string): string => (colorEnabled ? `${ESC}${code}m${text}${ESC}${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
};

export const symbol = {
  ok: style.green(unicodeEnabled ? '✓' : 'OK'),
  fail: style.red(unicodeEnabled ? '✗' : 'XX'),
  warn: style.yellow(unicodeEnabled ? '⚠' : '!!'),
  info: style.blue(unicodeEnabled ? '·' : '--'),
};

/** Two-column key/value block with aligned values. */
export function keyValue(entries: readonly (readonly [string, string])[], indent = '  '): string {
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries
    .map(([key, value]) => `${indent}${style.grey(key.padEnd(width))}  ${value}`)
    .join('\n');
}

export function heading(text: string): string {
  return `\n${style.bold(text)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
