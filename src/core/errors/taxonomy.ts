/**
 * Error taxonomy.
 *
 * Errors carry a machine-readable `code` so callers classify by type, never by
 * string-matching a message. The retry-policy classes (transient / blocked /
 * rate-limited) arrive with the engine; this file holds only what M0 can throw.
 */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_PARSE'
  | 'DB_PATH_UNSAFE'
  | 'DB_MIGRATION_FAILED'
  | 'DB_OPEN_FAILED'
  | 'IMPORT_FILE_MISSING'
  | 'IMPORT_SHEET_MISSING'
  | 'IMPORT_READ_FAILED'
  | 'IMPORT_EMPTY'
  | 'IMPORT_MISSING_COLUMN'
  | 'EXPORT_INCOMPLETE'
  | 'PLAN_NO_SEEDS'
  | 'PLAN_NO_MATCH'
  | 'PLATFORM_UNSUPPORTED'
  | 'FATAL';

export interface AppErrorOptions {
  readonly code: ErrorCode;
  /** Actionable next step for the user. Printed by the CLI beneath the message. */
  readonly hint?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Base for every error this application raises deliberately.
 *
 * `isAppError` is used rather than `instanceof` at CLI boundaries, because a
 * duplicated module instance (a real hazard with mixed ESM/CJS resolution)
 * would break `instanceof` while leaving the brand intact.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /** @internal Brand used by {@link isAppError}. */
  readonly __isAppError = true as const;

  constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.hint = options.hint;
    this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ConfigError extends AppError {}
export class DatabaseError extends AppError {}
export class PlatformError extends AppError {}
/** Bad or unreadable seed data. Always a user-fixable input problem. */
export class ImportError extends AppError {}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isAppError' in value &&
    value.__isAppError === true
  );
}

/** Narrow an unknown thrown value to a message without losing non-Error throws. */
export function errorMessage(value: unknown): string {
  if (isAppError(value) || value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
