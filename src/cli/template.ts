/**
 * The starter config file written by `gms init`.
 *
 * Kept as a string in TypeScript rather than a `.yaml` asset so it survives the
 * build without a file-copy step, and so it can never drift out of the package.
 * The comments here are the primary documentation most users will read.
 */
export const CONFIG_TEMPLATE = `# gms configuration
#
# Precedence, lowest to highest:
#   built-in defaults -> this file -> gms.config.local.yaml -> GMS_* env vars -> CLI flags
#
# Every key below is optional; the values shown are the defaults. Put secrets in
# environment variables, never in this file — this file is meant to be committed,
# and gms.config.local.yaml (gitignored) is the place for personal overrides.
#
# Inspect the merged result at any time with:  gms config show --resolved

project:
  name: gms
  # Root for all runtime state: database, logs, artifacts, exports.
  # Relative paths resolve against this file's directory, not your shell's cwd.
  dataDir: ./data

database:
  driver: sqlite
  # Relative to project.dataDir.
  file: gms.sqlite

  # Write-ahead logging. Leave this on: it lets reads run while a worker writes.
  wal: true

  # Milliseconds to wait on a locked database before failing.
  # Deliberately short. SQLite's busy handler sleeps the calling thread, and
  # because the driver is synchronous that stalls every worker and timer in the
  # process. Contention is handled by retry-with-jitter instead.
  busyTimeoutMs: 250

  # NORMAL is safe under WAL: a crash cannot corrupt the database, though the
  # last transaction may be lost. FULL survives power loss but costs an fsync on
  # every write.
  synchronous: NORMAL

  # Refuse to run if the database would live in a OneDrive/Dropbox/iCloud folder.
  # Sync agents copy files mid-transaction and sync the -wal/-shm sidecars
  # independently, which produces corrupt copies and can clobber the live file.
  # Network shares are refused regardless of this setting.
  allowCloudSync: false

logging:
  # trace | debug | info | warn | error | fatal
  level: info
  # 'auto' = human-readable on a terminal, NDJSON when piped.
  pretty: auto
  # Also write NDJSON logs to dataDir/logs.
  file: true
  # Extra redaction paths, merged with the built-in secret paths.
  redact: []

runtime:
  # Concurrent browser workers. Each is roughly 200-300 MB of Chromium, so 4 is
  # comfortable on a 4 GB VPS and 8 wants 8 GB.
  workers: 4
  # HTTP workers for email enrichment. Far cheaper than browsers.
  httpWorkers: 16

  # How long a worker owns a job before the reaper may reclaim it. Set this
  # generously above your p99 job duration: a worker whose event loop stalls
  # past the lease is fenced out and its work discarded.
  jobLeaseSeconds: 300
  heartbeatSeconds: 30

  # On Ctrl-C, how long in-flight jobs get to checkpoint before being abandoned.
  shutdownGraceSeconds: 30
  reaperIntervalSeconds: 60

  adaptiveConcurrency:
    # Backs off hard when the block rate rises, then creeps back up.
    enabled: true
    min: 1
    max: 8
    blockRateThreshold: 0.2

browser:
  headless: true
  # channel: chrome          # use an installed Chrome instead of the bundled build
  # executablePath: /path/to/chrome

  # Aborting these is worth 3-5x on page load and a large saving on metered
  # residential proxies. 'stylesheet' is available but leaving it out is
  # deliberate: Maps lays the results feed out with CSS, and a feed that never
  # lays out cannot be scrolled.
  blockResources: [image, media, font]

  navigationTimeoutMs: 45000
  actionTimeoutMs: 15000

  # Retire a context after this many jobs, bounding memory growth over a run
  # that lasts days.
  jobsPerContext: 10

  timezoneId: America/New_York

  artifacts:
    # Written to dataDir/artifacts/{runId}/{jobId}/ when a job fails.
    onFailure: [screenshot, html]
    retainDays: 14

proxy:
  # none | list | gateway
  # 'none' is explicit on purpose: volume scraping from your own IP gets rate
  # limited quickly, and silently falling back to it is worse than failing.
  mode: none

  list:
    # A file of  host:port  or  host:port:username:password  or  scheme://...
    # Its contents are secret; the path is not.
    # file: ./proxies.txt
    defaultScheme: http

  gateway:
    # A single rotating endpoint. Must be http:// or https:// — Playwright
    # rejects SOCKS with credentials, and the sticky session token is carried in
    # the username.
    # server: http://gate.provider.com:7777
    # username: your-account          # set via GMS_PROXY__GATEWAY__USERNAME
    # password: your-password         # set via GMS_PROXY__GATEWAY__PASSWORD

    # Sticky-session pattern. Providers disagree on the format, so confirm the
    # exact token with yours. {session} is substituted per identity.
    # sessionPattern: "{username}-session-{session}"
    sessionTtlSeconds: 600
    # country: US

  healthCheckUrl: https://api.ipify.org?format=json
  maxConsecutiveFailures: 3
  # How long a blocked identity is benched.
  banCooldownSeconds: 900

humanize:
  enabled: true
  # Delays are log-normal within these ranges, not uniform: human pauses cluster
  # low with a long tail. A fixed wait is both slower and a clean automation
  # signal.
  delayBetweenListingsMs: [400, 1400]
  delayBetweenJobsMs: [1500, 5000]
  scroll:
    stepPx: [300, 900]
    pauseMs: [350, 1200]
`;

/** `.gitignore` entries `gms init` ensures are present. */
export const GITIGNORE_ENTRIES = ['# gms runtime state', 'data/', 'gms.config.local.yaml', '.env'];
