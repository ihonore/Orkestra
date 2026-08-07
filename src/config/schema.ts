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

export const BrowserSchema = z
  .object({
    headless: z.boolean().default(true),
    /** Chromium channel, e.g. `chrome`. Omit to use Playwright's bundled build. */
    channel: z.string().min(1).optional(),
    executablePath: z.string().min(1).optional(),
    /** Slows every action. Debugging only — it is a strong automation signal. */
    slowMoMs: z.number().int().min(0).max(5_000).default(0),
    /**
     * Resource types to abort. Worth 3-5x on page load and a large saving on
     * metered residential proxies.
     *
     * `stylesheet` is available but off by default: Maps lays the results feed
     * out with CSS, and a feed that never lays out cannot be scrolled.
     */
    blockResources: z
      .array(z.enum(['image', 'media', 'font', 'stylesheet']))
      .default(['image', 'media', 'font']),
    navigationTimeoutMs: z.number().int().min(1_000).max(300_000).default(45_000),
    actionTimeoutMs: z.number().int().min(500).max(120_000).default(15_000),
    /** Retire a context after this many jobs, bounding memory growth. */
    jobsPerContext: z.number().int().min(1).max(1_000).default(10),
    /**
     * Locale is pinned, not configurable per run.
     *
     * Three separate mechanisms depend on English: the rating's
     * `aria-label*="star"`, the end-of-list sentinel text, and the consent
     * button labels. A different locale silently breaks all three.
     */
    timezoneId: z.string().min(1).default('America/New_York'),
    artifacts: z
      .object({
        onFailure: z.array(z.enum(['screenshot', 'html'])).default(['screenshot', 'html']),
        retainDays: z.number().int().min(1).max(365).default(14),
      })
      .prefault({}),
  })
  .strict();

export const ProxySchema = z
  .object({
    /** `none` is explicit so nobody scrapes from the office IP by accident. */
    mode: z.enum(['none', 'list', 'gateway']).default('none'),
    list: z
      .object({
        /** File of `host:port[:username:password]` or `scheme://...` lines. */
        file: z.string().min(1).optional(),
        /** Scheme assumed for bare `host:port` entries. */
        defaultScheme: z.enum(['http', 'https']).default('http'),
      })
      .prefault({}),
    gateway: z
      .object({
        server: z.string().min(1).optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        /**
         * Sticky-session username pattern containing `{session}`.
         *
         * Providers disagree on the format, so this is configuration rather than
         * a hardcoded `-session-`. Confirm the exact token with your provider.
         */
        sessionPattern: z.string().min(1).optional(),
        sessionTtlSeconds: z.number().int().min(30).max(86_400).default(600),
        country: z.string().length(2).optional(),
      })
      .prefault({}),
    healthCheckUrl: z.string().url().default('https://api.ipify.org?format=json'),
    maxConsecutiveFailures: z.number().int().min(1).max(20).default(3),
    banCooldownSeconds: z.number().int().min(10).max(86_400).default(900),
  })
  .strict();

export const HumanizeSchema = z
  .object({
    enabled: z.boolean().default(true),
    delayBetweenListingsMs: RangeSchema.default([400, 1_400]),
    delayBetweenJobsMs: RangeSchema.default([1_500, 5_000]),
    scroll: z
      .object({
        stepPx: RangeSchema.default([300, 900]),
        pauseMs: RangeSchema.default([350, 1_200]),
      })
      .prefault({}),
  })
  .strict();

export const RuntimeSchema = z
  .object({
    /** Concurrent browser workers. */
    workers: z.number().int().min(1).max(64).default(4),
    /** Concurrent HTTP workers for email enrichment; far cheaper than browsers. */
    httpWorkers: z.number().int().min(1).max(256).default(16),
    jobLeaseSeconds: z.number().int().min(30).max(3_600).default(300),
    heartbeatSeconds: z.number().int().min(5).max(600).default(30),
    shutdownGraceSeconds: z.number().int().min(0).max(600).default(30),
    reaperIntervalSeconds: z.number().int().min(10).max(600).default(60),
    adaptiveConcurrency: z
      .object({
        enabled: z.boolean().default(true),
        min: z.number().int().min(1).max(64).default(1),
        max: z.number().int().min(1).max(64).default(8),
        /** Rolling block rate above which concurrency halves. */
        blockRateThreshold: z.number().min(0.01).max(1).default(0.2),
      })
      .prefault({}),
  })
  .strict();

export const HttpSchema = z
  .object({
    timeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    maxRedirects: z.number().int().min(0).max(20).default(5),
    /** Hard cap per response. A 50 MB page never repays reading it. */
    maxBodyBytes: z.number().int().min(64_000).default(2_097_152),
    concurrencyPerHost: z.number().int().min(1).max(16).default(2),
    perHostDelayMs: RangeSchema.default([250, 900]),
    /** A site's own Crawl-delay is honoured on top of this. */
    respectRobots: z.boolean().default(true),
  })
  .strict();

export const EnrichmentSchema = z
  .object({
    websiteEmails: z
      .object({
        enabled: z.boolean().default(true),
        /** 0 = landing page only. 1 covers the contact/about pages that matter. */
        maxDepth: z.number().int().min(0).max(4).default(1),
        maxPages: z.number().int().min(1).max(200).default(8),
        maxTimePerDomainMs: z.number().int().min(5_000).max(600_000).default(60_000),
        maxBytesPerDomain: z.number().int().min(100_000).default(5_242_880),
        followSubdomains: z.boolean().default(false),
        /**
         * A page offering more addresses than this is a staff directory, not a
         * business. In the legacy data one university page contributed 67.
         */
        maxEmailsPerPage: z.number().int().min(1).max(100).default(5),
        maxEmailsPerDomain: z.number().int().min(1).max(500).default(25),
        recrawlAfterDays: z.number().int().min(1).max(365).default(90),
        validation: z
          .object({
            /**
             * Reject .gov, .mil and state/local government domains.
             *
             * Government bodies are not sales prospects.
             */
            excludeGovernment: z.boolean().default(true),
            /**
             * Reject .edu and school domains.
             *
             * On by default because university directories were the single
             * largest junk source in the legacy data: 146 of 597 addresses came
             * from four universities. Turn off only if you sell to institutions.
             */
            excludeEducation: z.boolean().default(true),
            /** Extra domains to reject outright. */
            blockedDomains: z.array(z.string()).default([]),
            /** Keep info@/sales@ addresses. They convert worse but still convert. */
            keepRoleAddresses: z.boolean().default(true),
          })
          .prefault({}),
      })
      .prefault({}),
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
    runtime: RuntimeSchema.prefault({}),
    browser: BrowserSchema.prefault({}),
    proxy: ProxySchema.prefault({}),
    humanize: HumanizeSchema.prefault({}),
    http: HttpSchema.prefault({}),
    enrichment: EnrichmentSchema.prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Cross-field checks the per-field schemas cannot express. Catching these at
    // load time beats failing on the first job, an hour into a run.
    if (config.proxy.mode === 'list' && config.proxy.list.file === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['proxy', 'list', 'file'],
        message: 'proxy.list.file is required when proxy.mode is "list"',
      });
    }
    if (config.proxy.mode === 'gateway') {
      if (config.proxy.gateway.server === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['proxy', 'gateway', 'server'],
          message: 'proxy.gateway.server is required when proxy.mode is "gateway"',
        });
      }
      if (config.proxy.gateway.server?.startsWith('socks') === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['proxy', 'gateway', 'server'],
          message:
            'a sticky-session gateway cannot use SOCKS: Playwright rejects SOCKS with credentials, ' +
            'and the session token is carried in the username',
        });
      }
    }
    if (config.runtime.adaptiveConcurrency.min > config.runtime.adaptiveConcurrency.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['runtime', 'adaptiveConcurrency', 'min'],
        message: 'adaptiveConcurrency.min must not exceed max',
      });
    }
  });

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
