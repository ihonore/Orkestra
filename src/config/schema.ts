/**
 * The configuration surface.
 *
 * This schema is the single definition of what is configurable. It validates the
 * config file today and will validate HTTP request bodies when the SaaS API
 * arrives, so it must stay free of CLI- or file-specific concerns.
 *
 * M0 defines only the sections M0 actually honors. Sections for the browser,
 * proxies, automations and exporters are added by the milestone that implements
 * them — a config key that nothing reads is a lie to the user.
 */
import { z } from 'zod';

/** An inclusive `[min, max]` millisecond range used for jittered delays. */
export const RangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([min, max]) => min <= max, { message: 'range must be [min, max] with min <= max' });

export type Range = z.infer<typeof RangeSchema>;

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const ProjectSchema = z
  .object({
    /** Used in log lines and export filenames. */
    name: z.string().min(1).default('gms'),
    /**
     * Root for all runtime state: the database, logs, artifacts and exports.
     * Relative paths resolve against the project root, not the shell's cwd.
     */
    dataDir: z.string().min(1).default('./data'),
  })
  .strict();

export const DatabaseSchema = z
  .object({
    /** Only `sqlite` is implemented. `postgres` is a deliberate future option. */
    driver: z.literal('sqlite').default('sqlite'),
    /** Relative paths resolve against `project.dataDir`. */
    file: z.string().min(1).default('gms.sqlite'),
    /**
     * Write-ahead logging. Leave on: it is what allows readers to run while a
     * worker writes. Off is for network filesystems, which are refused anyway.
     */
    wal: z.boolean().default(true),
    /**
     * Busy timeout in milliseconds.
     *
     * Deliberately short. SQLite's busy handler *sleeps the calling thread*, and
     * because better-sqlite3 is synchronous that stalls the entire event loop —
     * every worker, every timer, and the job heartbeat — for the full duration.
     * Contention is handled by application-level retry with jitter instead, so
     * this is a backstop rather than the primary mechanism.
     */
    busyTimeoutMs: z.number().int().min(0).max(5_000).default(250),
    /**
     * `synchronous` pragma. NORMAL is safe under WAL (a crash cannot corrupt the
     * database, though the last transaction may be lost) and is dramatically
     * faster. FULL survives OS-level crashes at a heavy write cost.
     */
    synchronous: z.enum(['OFF', 'NORMAL', 'FULL']).default('NORMAL'),
    /** Permit the database to live in a cloud-synced folder. Never permits a network share. */
    allowCloudSync: z.boolean().default(false),
  })
  .strict();

export const LoggingSchema = z
  .object({
    level: LogLevelSchema.default('info'),
    /** `auto` uses human-readable output on a TTY and NDJSON when piped. */
    pretty: z.union([z.boolean(), z.literal('auto')]).default('auto'),
    /** Write NDJSON logs under `dataDir/logs`. Independent of console output. */
    file: z.boolean().default(true),
    /**
     * Extra pino redaction paths, merged with the built-in ones.
     * @see src/core/logging/redact.ts
     */
    redact: z.array(z.string()).default([]),
  })
  .strict();

export const ConfigSchema = z
  .object({
    // `prefault` rather than `default`: it substitutes on the *input* side, so an
    // omitted section still has each of its own field defaults applied. A plain
    // `.default({})` would demand a fully-populated object here.
    project: ProjectSchema.prefault({}),
    database: DatabaseSchema.prefault({}),
    logging: LoggingSchema.prefault({}),
  })
  .strict();

/** Config exactly as written by the user: every key optional. */
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Config after validation and defaulting, before paths are resolved. */
export type ValidatedConfig = z.output<typeof ConfigSchema>;

/**
 * The config the application actually runs on.
 *
 * Adds absolute paths resolved once at startup, so no downstream module ever
 * re-resolves a path or reads `process.cwd()`.
 */
export interface ResolvedConfig extends ValidatedConfig {
  readonly paths: {
    /** Directory containing the config file, or cwd when there is none. */
    readonly root: string;
    readonly dataDir: string;
    readonly databaseFile: string;
    readonly logsDir: string;
    readonly artifactsDir: string;
    readonly exportsDir: string;
  };
  /** Stable hash of the effective config, recorded on each run. */
  readonly hash: string;
  /** Which layers contributed, in precedence order. Shown by `gms config show`. */
  readonly sources: readonly ConfigSource[];
}

export interface ConfigSource {
  readonly kind: 'defaults' | 'file' | 'env' | 'flags';
  readonly detail: string;
}
