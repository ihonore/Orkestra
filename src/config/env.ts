/**
 * Environment-variable config layer.
 *
 * Mapping: `GMS_` prefix, `__` separates nesting levels, and each level is
 * SNAKE_CASE converted to camelCase.
 *
 *   GMS_LOGGING__LEVEL=debug             -> logging.level = "debug"
 *   GMS_DATABASE__BUSY_TIMEOUT_MS=500    -> database.busyTimeoutMs = 500
 *   GMS_DATABASE__WAL=false              -> database.wal = false
 *   GMS_LOGGING__REDACT='["a.b"]'        -> logging.redact = ["a.b"]
 *
 * This layer is where secrets belong. They are never read from the config file.
 *
 * `GMS_DEBUG` is reserved: it turns on stack traces in the CLI and is not a
 * config key. See {@link RESERVED}.
 */

const PREFIX = 'GMS_';

/**
 * `GMS_*` names that control the tool itself rather than the configuration.
 *
 * Without this list the mapping is total: every `GMS_`-prefixed variable
 * becomes a config key, the schema is strict, and so `GMS_DEBUG=1` — which the
 * CLI itself tells you to set when a command fails — made every command die
 * with `Unrecognized key: "debug"` before it ran. Troubleshooting advice that
 * breaks the tool is worse than no advice.
 *
 * Anything added here must be documented, because it is now a name a user can
 * no longer use for a config key.
 */
const RESERVED = new Set(['GMS_DEBUG']);

function snakeToCamel(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

/**
 * Coerce an env string to a JSON value.
 *
 * Only strings that *look* like JSON literals are parsed, so an ordinary value
 * such as `info` stays a string while `500`, `false` and `["a"]` become their
 * real types. Parsing everything would silently turn a filename like `"123"`
 * into a number.
 */
function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return raw;
  const looksLikeJson =
    /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('"');
  if (!looksLikeJson) return raw;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function assignDeep(target: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i]!;
    const existing = cursor[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
}

export interface EnvLayer {
  readonly values: Record<string, unknown>;
  /** Env var names that contributed, for `gms config show --resolved`. */
  readonly names: readonly string[];
  /** Dotted config path -> the variable that set it, so errors can name it. */
  readonly origins: ReadonlyMap<string, string>;
}

/** Build a partial config object from environment variables. */
export function readEnvLayer(env: NodeJS.ProcessEnv = process.env): EnvLayer {
  const values: Record<string, unknown> = {};
  const names: string[] = [];
  const origins = new Map<string, string>();

  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || !name.startsWith(PREFIX) || RESERVED.has(name)) continue;
    const body = name.slice(PREFIX.length);
    if (body === '') continue;

    const keyPath = body.split('__').filter(Boolean).map(snakeToCamel);
    if (keyPath.length === 0) continue;

    assignDeep(values, keyPath, coerce(raw));
    names.push(name);
    origins.set(keyPath.join('.'), name);
  }

  return { values, names: names.sort(), origins };
}
