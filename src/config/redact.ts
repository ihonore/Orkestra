/**
 * Config redaction.
 *
 * One list of secret-bearing paths, used both to build pino's redaction config
 * and to sanitize `gms config show`. Keeping a single source prevents the
 * classic split where logs are clean but a debug command prints the password.
 *
 * Paths use dotted notation and may contain `*` to match any single key.
 */

export const REDACTED = '[redacted]';

/**
 * Config paths whose values must never be printed or logged.
 *
 * Scoped to what actually grants access. `gms config show` is meant to be
 * pasteable into a bug report, and over-redaction makes it useless for the
 * questions people actually ask of it:
 *
 *  - `gateway.username` is shown. With sticky sessions it carries the session
 *    token pattern, which is exactly what someone debugging "why is every
 *    request coming from a different IP" needs to see. On its own it grants
 *    nothing; the password is what does.
 *  - `list.file` is a path, not a credential. Its *contents* are secret and are
 *    never printed, but hiding the path only obstructs "why is my proxy list
 *    not loading".
 */
export const SECRET_CONFIG_PATHS: readonly string[] = [
  'proxy.gateway.password',
  'exporters.sheets.credentials',
  'exporters.sheets.privateKey',
];

/** Additional paths redacted in log records (not config), e.g. HTTP headers. */
export const SECRET_LOG_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'proxy.password',
  'credentials',
];

function matches(pathSegments: readonly string[], patternSegments: readonly string[]): boolean {
  if (pathSegments.length !== patternSegments.length) return false;
  return patternSegments.every((pattern, i) => pattern === '*' || pattern === pathSegments[i]);
}

/**
 * Deep-copy `value`, replacing any secret-bearing leaf with a placeholder.
 * Never mutates the input.
 */
export function redactSecrets<T>(
  value: T,
  secretPaths: readonly string[] = SECRET_CONFIG_PATHS,
): T {
  const patterns = secretPaths.map((p) => p.split('.'));

  const walk = (node: unknown, trail: string[]): unknown => {
    if (patterns.some((pattern) => matches(trail, pattern))) {
      return node === undefined ? undefined : REDACTED;
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, [...trail, String(i)]));
    }
    if (typeof node === 'object' && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child, [...trail, key]);
      }
      return out;
    }
    return node;
  };

  return walk(value, []) as T;
}
