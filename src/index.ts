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

export {
  JOB_STATUSES,
  JobsRepository,
  CategoriesRepository,
  CitiesRepository,
  isBusyError,
  retryOnBusy,
  type JobRecord,
  type JobSpec,
  type JobStatus,
  type Lease,
} from './db/index.js';

export {
  GROUPINGS,
  ProgressRepository,
  type GroupingName,
  type ProgressGroup,
} from './db/repositories/progress.js';

export {
  planGoogleMapsJobs,
  priorityFor,
  taskKeyFor,
  type GoogleMapsJobParams,
} from './core/engine/planner.js';

export {
  ShutdownController,
  sweepOrphanedBrowsers,
  type ShutdownReason,
} from './core/engine/shutdown.js';

export {
  BrowserPool,
  installResourceBlocking,
  visibleText,
  type BlockableResource,
  type BrowserLease,
  type BrowserPoolOptions,
} from './core/browser/pool.js';

export {
  AdaptiveConcurrency,
  detectBlock,
  type BlockSignal,
  type BlockVerdict,
} from './core/browser/block-detector.js';

export {
  consentCacheKey,
  handleConsent,
  isConsentUrl,
  type ConsentResult,
} from './core/browser/consent.js';

export {
  humanPause,
  jitter,
  randomViewport,
  scrollBurst,
  sleep,
  type Range,
} from './core/browser/humanize.js';

export { ArtifactWriter, pruneArtifacts, type ArtifactRecord } from './core/browser/artifacts.js';

export { createProxyProvider } from './core/proxy/factory.js';
export {
  NoProxyProvider,
  RotatingGatewayProvider,
  StaticListProvider,
} from './core/proxy/providers.js';
export { parseProxyLine, parseProxyList, stickyUsername } from './core/proxy/parse.js';
export type {
  ProxyHealth,
  ProxyOutcome,
  ProxyProbe,
  ProxyProvider,
  ProxySession,
  ProxySettings,
} from './core/proxy/types.js';

export { APP_NAME, APP_VERSION } from './version.js';
