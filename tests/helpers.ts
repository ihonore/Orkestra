import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Create a throwaway directory. Registered for cleanup by `cleanupTempDirs`. */
const created: string[] = [];

export function tempDir(prefix = 'gms-test-'): string {
  // realpathSync resolves the macOS /var -> /private/var symlink, so assertions
  // comparing paths do not fail on an equivalent-but-different string.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}
