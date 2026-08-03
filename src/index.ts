/**
 * Public surface of the platform.
 *
 * This is what the forthcoming HTTP API and any embedding process import. The
 * CLI is one consumer of this module, not a privileged path — keeping that true
 * is what makes a dashboard possible later without re-plumbing the core.
 */
export {
  ConfigSchema,
  hashConfig,
  loadConfig,
  redactSecrets,
  type ConfigInput,
  type ConfigSource,
  type LogLevel,
  type ResolvedConfig,
  type ValidatedConfig,
} from './config/index.js';

export {
  AppError,
  ConfigError,
  DatabaseError,
  PlatformError,
  errorMessage,
  isAppError,
  type ErrorCode,
} from './core/errors/taxonomy.js';

export {
  createLogger,
  createSilentLogger,
  type LogBindings,
  type Logger,
} from './core/logging/logger.js';

export {
  assertSafeDatabasePath,
  assessStoragePath,
  type StorageAssessment,
  type StorageRisk,
} from './core/util/storage-safety.js';

export { displayPath, expandHome, resolvePath, safeSegment } from './core/util/paths.js';

export {
  META_KEYS,
  MetaRepository,
  appliedMigrations,
  checkIntegrity,
  describeDatabase,
  migrate,
  openDatabase,
  openDatabaseFromConfig,
  pendingMigrations,
  type DatabaseInfo,
  type Migration,
  type MigrateResult,
  type SqliteDriver,
} from './db/index.js';

export { APP_NAME, APP_VERSION } from './version.js';
