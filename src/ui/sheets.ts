/**
 * Google Sheets settings, as the dashboard edits them.
 *
 * The page sends a pasted sheet URL, a tab name and the service-account key
 * file. This module turns those into config values and a key file on disk —
 * and refuses anything that is not what it claims to be, because a wrong key
 * otherwise surfaces only later, as an export failing with a bare 403.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where an uploaded key is kept: the user's home, never the project. */
export function defaultCredentialsDir(): string {
  return path.join(os.homedir(), 'gms-credentials');
}

export const KEY_FILE_NAME = 'gms-exporter.json';

/**
 * The key's file name for a project.
 *
 * The default project keeps the original name, so an existing install's
 * config line stays valid. Any other project — a campaign — gets its own, so
 * uploading one campaign's key cannot overwrite another's.
 */
export function keyFileName(projectName: string): string {
  if (projectName === 'gms') return KEY_FILE_NAME;
  const safe = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe === '' ? KEY_FILE_NAME : `${safe}-exporter.json`;
}

/**
 * The spreadsheet id, from either the id itself or any URL of the sheet —
 * `/edit#gid=0`, `/edit?usp=sharing`, a `/copy` link. People paste the URL.
 */
export function parseSpreadsheetId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(text);
  if (fromUrl !== null) return fromUrl[1]!;
  return /^[A-Za-z0-9_-]{20,}$/.test(text) ? text : null;
}

/** A tab name Sheets will accept, or null. */
export function parseSheetName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  // eslint-disable-next-line no-control-regex
  if (name === '' || name.length > 100 || /[\u0000-\u001f]/.test(name)) return null;
  return name;
}

export class KeyFileError extends Error {}

/**
 * Check that `text` is a Google service-account key and return its address.
 *
 * Several JSON files from the Cloud console look alike: an OAuth client
 * secret, an API key export, a key from the wrong account type. Only a
 * service-account key can authenticate an unattended export.
 */
export function parseServiceAccountKey(text: string): { clientEmail: string } {
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new KeyFileError('That file is not JSON. Choose the .json key you downloaded.');
  }
  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new KeyFileError('That file is not a Google key.');
  }
  if ('installed' in key || 'web' in key) {
    throw new KeyFileError(
      'That is an OAuth client secret, not a service-account key. Create a key under ' +
        'IAM & Admin → Service accounts → Keys → Add key → JSON.',
    );
  }
  if (key['type'] !== 'service_account') {
    throw new KeyFileError(
      'That file is not a service-account key ("type" is not service_account).',
    );
  }
  const email = key['client_email'];
  const privateKey = key['private_key'];
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new KeyFileError('That key has no client_email. Download it again.');
  }
  if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
    throw new KeyFileError('That key has no private key in it. Download it again.');
  }
  return { clientEmail: email };
}

/**
 * Write the key where only this user can read it.
 *
 * Temporary name then rename, so a failure part-way cannot leave a truncated
 * key in place of a working one. The mode is a real restriction on macOS and
 * Linux; on Windows the user's home folder is already private to them.
 */
export function saveServiceAccountKey(
  text: string,
  dir: string,
  fileName: string = KEY_FILE_NAME,
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, fileName);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}

/**
 * How to record the key's path in config: `~/...` when it is in the home
 * folder, so the same config line works on the Mac and on the VPS.
 */
export function portablePath(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return file;
}

/** The address a key authenticates as, if its file can be read. */
export function keyEmail(file: string): string | null {
  try {
    const key = JSON.parse(fs.readFileSync(file, 'utf8')) as { client_email?: unknown };
    return typeof key.client_email === 'string' ? key.client_email : null;
  } catch {
    return null;
  }
}
