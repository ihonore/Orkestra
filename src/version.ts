/**
 * Package identity, read from package.json at runtime.
 *
 * Resolved relative to this module so it works identically from `src` under tsx
 * and from `dist` after a build — both are exactly one level below the package
 * root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { moduleDir } from './core/util/paths.js';

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly engines?: { readonly node?: string };
}

export const PACKAGE_ROOT = path.resolve(moduleDir(import.meta.url), '..');

function readPackageJson(): PackageJson {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as PackageJson;
  } catch {
    return {};
  }
}

const pkg = readPackageJson();

export const APP_NAME = pkg.name ?? 'gms';
export const APP_VERSION = pkg.version ?? '0.0.0';
/** The `engines.node` range, e.g. `">=24.13.0"`. */
export const REQUIRED_NODE_RANGE = pkg.engines?.node ?? '';
