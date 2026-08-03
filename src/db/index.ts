export {
  checkIntegrity,
  describeDatabase,
  openDatabase,
  openDatabaseFromConfig,
  type DatabaseInfo,
  type OpenDatabaseOptions,
} from './client.js';
export type {
  OpenDriverOptions,
  PreparedStatement,
  RunResult,
  SqliteDriver,
  SqlParams,
  SqlValue,
  TransactionMode,
} from './driver/types.js';
export {
  appliedMigrations,
  defaultMigrationsDir,
  loadMigrations,
  migrate,
  pendingMigrations,
  type AppliedMigration,
  type Migration,
  type MigrateOptions,
  type MigrateResult,
} from './migrate.js';
export { META_KEYS, MetaRepository, type MetaEntry } from './repositories/meta.js';
export {
  BaseRepository,
  type Repository,
  type Timestamp,
  type Work,
} from './repositories/types.js';
