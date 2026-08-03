/**
 * Layered configuration loader.
 *
 * Precedence, lowest to highest:
 *   defaults (the zod schema)
 *     -> gms.config.yaml
 *       -> gms.config.local.yaml   (gitignored; personal overrides)
 *         -> GMS_* environment variables
 *           -> CLI flags
 *
 * The result is validated once, frozen, hashed, and passed around. Nothing
 * downstream re-reads the environment or the filesystem for configuration.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../core/errors/taxonomy.js';
import { displayPath, resolvePath } from '../core/util/paths.js';
import { readEnvLayer } from './env.js';
import { redactSecrets } from './redact.js';
import { ConfigSchema, type ConfigSource, type ResolvedConfig } from './schema.js';

/** Config filenames searched for, in order. The `.local` variants override. */
export const CONFIG_FILENAMES = ['gms.config.yaml', 'gms.config.yml', 'gms.config.json'] as const;

export const LOCAL_CONFIG_FILENAMES = [
  'gms.config.local.yaml',
  'gms.config.local.yml',
  'gms.config.local.json',
] as const;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursive merge where objects combine and everything else replaces.
 *
 * Arrays replace rather than concatenate: if a user sets `logging.redact`, they
 * mean *that* list, not that list appended to the default.
 */
function mergeDeep(base: PlainObject, overlay: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    if (overlayValue === undefined) continue;
    const baseValue = out[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(overlayValue)
        ? mergeDeep(baseValue, overlayValue)
        : overlayValue;
  }
  return out;
}

function readConfigFile(filePath: string): PlainObject {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Could not read config file: ${displayPath(filePath)}`, {
      code: 'CONFIG_NOT_FOUND',
      cause,
    });
  }

  let parsed: unknown;
  try {
    // YAML is a superset of JSON, so one parser handles both extensions.
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new ConfigError(`Config file is not valid YAML or JSON: ${displayPath(filePath)}`, {
      code: 'CONFIG_PARSE',
      hint: 'Check indentation and quoting.',
      cause,
    });
  }

  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Config file must contain an object at the top level.`, {
      code: 'CONFIG_PARSE',
      details: { file: displayPath(filePath) },
    });
  }
  return parsed;
}

function findFirstExisting(dir: string, filenames: readonly string[]): string | null {
  for (const name of filenames) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Render a zod error as an indented, human-readable list of field problems. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${where}: ${issue.message}`;
    })
    .join('\n');
}

/** Stable hash of the effective config: key order must not change the result. */
export function hashConfig(value: unknown): string {
  const canonical = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(canonical);
    if (isPlainObject(node)) {
      return Object.fromEntries(
        Object.keys(node)
          .sort()
          .map((key) => [key, canonical(node[key])]),
      );
    }
    return node;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
    .slice(0, 16);
}

export interface LoadConfigOptions {
  /** Directory to search for config files. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Explicit config file path. When set, the automatic search is skipped. */
  readonly configFile?: string;
  /** Highest-precedence overrides, normally from CLI flags. */
  readonly overrides?: PlainObject;
  /** Environment to read the `GMS_*` layer from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Load, merge, validate and resolve configuration.
 *
 * @throws {ConfigError} when a file is unreadable, unparseable, or the merged
 * result fails validation. Config problems are fatal at startup by design —
 * there is no partial-config mode.
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const sources: ConfigSource[] = [{ kind: 'defaults', detail: 'schema defaults' }];

  let merged: PlainObject = {};
  let root = cwd;

  if (options.configFile !== undefined) {
    const explicit = resolvePath(options.configFile, cwd);
    if (!fs.existsSync(explicit)) {
      throw new ConfigError(`Config file not found: ${displayPath(explicit)}`, {
        code: 'CONFIG_NOT_FOUND',
        hint: 'Run `gms init` to create one, or omit --config to use defaults.',
      });
    }
    merged = mergeDeep(merged, readConfigFile(explicit));
    sources.push({ kind: 'file', detail: displayPath(explicit) });
    root = path.dirname(explicit);
  } else {
    const primary = findFirstExisting(cwd, CONFIG_FILENAMES);
    if (primary !== null) {
      merged = mergeDeep(merged, readConfigFile(primary));
      sources.push({ kind: 'file', detail: displayPath(primary) });
      root = path.dirname(primary);
    }
    const local = findFirstExisting(cwd, LOCAL_CONFIG_FILENAMES);
    if (local !== null) {
      merged = mergeDeep(merged, readConfigFile(local));
      sources.push({ kind: 'file', detail: displayPath(local) });
    }
  }

  const envLayer = readEnvLayer(options.env ?? process.env);
  if (envLayer.names.length > 0) {
    merged = mergeDeep(merged, envLayer.values);
    sources.push({ kind: 'env', detail: envLayer.names.join(', ') });
  }

  if (options.overrides !== undefined && Object.keys(options.overrides).length > 0) {
    merged = mergeDeep(merged, options.overrides);
    sources.push({ kind: 'flags', detail: 'command-line flags' });
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration:\n${formatIssues(parsed.error)}`, {
      code: 'CONFIG_INVALID',
      hint: 'Run `gms config show` to see the merged configuration.',
      details: { sources: sources.map((s) => `${s.kind}: ${s.detail}`) },
    });
  }

  const validated = parsed.data;
  const dataDir = resolvePath(validated.project.dataDir, root);

  const resolved: ResolvedConfig = {
    ...validated,
    paths: {
      root,
      dataDir,
      databaseFile: resolvePath(validated.database.file, dataDir),
      logsDir: path.join(dataDir, 'logs'),
      artifactsDir: path.join(dataDir, 'artifacts'),
      exportsDir: path.join(dataDir, 'exports'),
    },
    // Hash the validated config only. Resolved paths are machine-specific, so
    // including them would make the same config hash differently per machine.
    hash: hashConfig(redactSecrets(validated)),
    sources,
  };

  return Object.freeze(resolved);
}
