# Google Maps Automation Platform — Architecture & Build Plan

## Context

You currently run Google Maps lead generation through an RTILA automation backed by a Google Sheet and a public Apps Script proxy. I analyzed all four legacy artifacts (the RTILA flow, the Apps Script backend, the RTILA custom command, and the 438-row spreadsheet export). The workflow works, but it is failing in ways the output data proves:

- **No stable identity for a business.** The Google Maps CID (in the listing URL) is the only natural key, and it is missing on 126 of 438 rows. Result: 50 byte-identical duplicate rows, 107 duplicate company names, and the same business re-scraped under different search terms with no dedup.
- **Progress tracking cannot express what you actually do.** `Cities!I` is per-city, `Services!C` is *global across all cities*. There is no way to record "Atlanta + Plumber done, Atlanta + Roofing pending." A crash mid-city loses the whole city, and category flags go stale across runs.
- **Two `compare-variables` nodes have `firstOperand: null, secondOperand: null`.** The "is the website reachable" gate never evaluates — the crawler runs unconditionally, including on empty websites. The gate guarding `close-page` is equally dead, so tabs leak.
- **Emails accumulate in `localStorage`, which is per-origin.** The reset writes to google.com's storage; the accumulator writes to the business site's storage. Emails leak between consecutive businesses on the same domain, and the reset never clears what was actually written.
- **The crawler picks links at random** (`randomize: true`, depth 1, max 5 pages). Contact and About pages are found by luck, not by design.
- **Email extraction regexes raw `innerHTML`**, so it harvests `insurance_logos@2x.jpg`, Sentry DSNs (`605a…@sentry-next.wixpress.com`), and university directory floods (67 addresses from `cau.edu` alone). Emails are then comma-joined into one cell.
- **Column mapping is off by one.** The flow writes `K:{{Thumbnail}}` and `L:{{GMaps Listing URL}}`, but the sheet's `K` header says LISTING URL.
- **The Apps Script endpoint is unauthenticated and takes a caller-supplied `spreadsheetUrl`.** Anyone with the `/exec` URL can read or write any spreadsheet your account can access — a textbook confused-deputy hole. The RTILA license key and customer email sit in plaintext in the exported flow and travel in query strings.
- **Throughput is hopeless.** One thread, one tab, fixed 15–30 s waits, a new tab per listing, an inline website crawl, and cell-by-cell `setValue` writes (12 API calls per listing). 185 cities × 85 categories is ~15,725 searches; at this pace that is months of wall clock.
- **No retries anywhere.** `elementNotFound: continue` and `errorHandling: dontShow` silence errors rather than handle them. A transient failure permanently loses that listing.

**Intended outcome:** a maintainable, modular automation *platform* — not a scraper script — where Google Maps is automation #1, state is local and crash-proof, storage targets are pluggable, and adding automation #2 requires no changes to the engine.

### Confirmed decisions

| Decision | Choice |
|---|---|
| V1 interface | CLI + config files; core shaped so a SaaS API/dashboard layers on later |
| Platform | Cross-platform by construction: macOS, Windows (incl. Windows VPS), Linux. Docker for Linux, never required on Windows |
| Control plane | Local-first. SQLite owns cities, categories, jobs, progress. Sheets becomes an *output*, not the database |
| Proxies | In scope from day one, with rotation and health tracking |
| Stack | Node.js + TypeScript + Playwright |
| Email validation | Syntactic + junk filtering. No SMTP probing. MX check as an optional module |
| Seed data | Import the existing 185 cities / 85 services from the xlsx, repairing the data on the way in |

### Working agreement

The milestone roadmap is the implementation contract. Rules for every milestone:

- Complete one milestone at a time; each must be fully functional and production-ready before the next begins.
- A working system always beats a feature-complete one. **M3 ships a Google Maps scraper you can actually use in production**, while later milestones continue.
- Small, self-contained commits. The project stays runnable at every stage.
- Tests accompany new functionality. No placeholder or stub implementations.
- Do not build future milestones early unless the current one genuinely requires it.
- If a later architectural change starts to look necessary, raise it for discussion before implementing.

---

## Recommended stack

**Node.js 24 LTS + TypeScript (strict) + Playwright ≥1.47 (Chromium) + SQLite via `better-sqlite3` ^13 (WAL) + Drizzle ORM + `undici` + `cheerio` + `zod` + `commander` + `pino`.**

Pinned by verification, not by habit:

- **`engines: { node: ">=24.15.0" }`.** Node 24 "Krypton" is Active LTS. That single floor clears `better-sqlite3` v13's real Node-API 10 requirement (22.14.0) *and* the version where `node:sqlite` stops emitting an experimental warning. Do not write `>=22`. Schedule a bump review for Q4 2026 when Node 26 becomes LTS.
- **`better-sqlite3` ^13.0.2, not v12.** The reason v13 solves the bare-Windows-VPS problem is *not* "it has prebuilds" — v12 had those too. It is that v13 ships N-API prebuilds **inside the npm tarball** with `gypfile: false` and no install script, so npm never invokes `node-gyp` and never downloads a binary at install time. v12 fetches from GitHub during install and falls back to `node-gyp rebuild` (Python + VS Build Tools) on any network hiccup — exactly the failure we are avoiding. Resolve versions from the npm registry only; the project has tagged GitHub releases that were never published to npm.
- **`drizzle-orm >= 0.45.2` is a security floor, not a preference** — CVE-2026-39356 (HIGH, SQL injection via unescaped identifiers) affects `< 0.45.2` and `1.0.0-beta.2..beta.20`. Drizzle is introduced in M1 with the actual schema; M0 uses raw SQL migrations behind the driver adapter.
- **Stay on `drizzle-orm` stable (0.45.x) with `better-sqlite3`.** The `node:sqlite` driver entrypoint exists only on the unreleased 1.0.0-rc line. `node:sqlite` remains a documented future option, not a near-term one.
- **Add a thin driver-adapter module in M0.** Swapping `better-sqlite3` ↔ `node:sqlite` is *not* one line: WAL setup differs at the raw-driver level (`db.pragma('journal_mode = WAL')` vs `sqlite.exec('PRAGMA journal_mode = WAL')`). Route all pragma / transaction / backup calls through the adapter so the swap stays contained.
- **Linux caveat:** `better-sqlite3` v13's glibc prebuilds need GLIBC ≥ 2.38, so Debian 12 / Ubuntu 22.04 / Amazon Linux 2 will fail. Windows and macOS are unaffected. There is also no `win32-ia32` prebuild, and because `gypfile: false` disables the node-gyp fallback, such a platform installs "successfully" and then throws at `require()`. `doctor` must preflight this with a clear message rather than letting users hit a raw module-load stack trace.

**Honest correction on portability:** moving SQLite → PostgreSQL later is *not* a mechanical Drizzle dialect flip. `sqlite-core` and `pg-core` are separate, non-interchangeable type hierarchies; every schema file must be rewritten (`sqliteTable` → `pgTable`, `integer({mode:'boolean'})` → `boolean()`, `text({mode:'json'})` → `jsonb()`), the migration folder must be regenerated from scratch, and a synchronous driver becomes an async pooled one. What Drizzle actually buys is that most **query-builder call sites survive**. That is worth real money, but it is days of work, not a config change — plan accordingly rather than assuming a free escape hatch.

Node over Python for four concrete reasons. Every extraction primitive you need runs *inside* the page — `page.evaluate`, XHR response bodies, JSON-LD, Cloudflare `data-cfemail` decoding — and is JavaScript regardless of host language; with Python you write the JS anyway and pay a marshalling tax. Playwright's Node binding is the reference implementation, and `playwright-python`'s sync API interacts badly with pooled concurrency. The SaaS trajectory means dashboard, API, and scraper share one language and — critically — one set of zod schemas that serve simultaneously as config validator, API request validator, and record contract. And the email crawler is I/O-bound, where `undici` + `cheerio` beats `httpx` + `BeautifulSoup` on both throughput and memory. Python's real advantages (pandas, sklearn) are not on the critical path; later AI enrichment is HTTP calls to an LLM API.

**Do not build on Crawlee.** It is a good framework, but its center of gravity is a *URL-centric* `RequestQueue` with its own storage layer. Adopting it means running two competing state systems: Crawlee's queue and your `jobs` table. Your unit of work is not a URL — it is a `(city, category)` pair with a lease, an attempt counter, a mid-scroll checkpoint, and a fan-out into domain-level enrichment jobs. Expressing lease/heartbeat/resume semantics through Crawlee's queue is fighting the framework. Take the parts that are pure value with no lock-in (`header-generator` / `fingerprint-injector` for header and fingerprint coherence) and write the ~600–900 line engine yourself. For a platform you intend to maintain for years and extend into a SaaS, owning that layer is the right trade.

**Trade-offs accepted.** A custom engine is more code to test than Crawlee's batteries-included path — mitigated by keeping the engine automation-agnostic and covering it with concurrency and crash-recovery tests (M1). SQLite means single-machine writes — accepted deliberately, because the repository layer and Drizzle schema port to Postgres when you need multi-machine, and the leasing statement becomes `FOR UPDATE SKIP LOCKED`.

---

## Project layout

**One package, not a monorepo.** There is one deployable in v1; a monorepo would cost TS project references, build orchestration, and version skew for no gain. The layout is arranged so each top-level `src/` folder is a *future* package: `src/core`, `src/db`, and `src/config` import nothing from `src/automations`, `src/cli`, or `src/exporters`, enforced by `dependency-cruiser` in CI. **Split trigger:** the day the HTTP API becomes a second deployable, promoting those three into `packages/core` is mechanical because the boundaries already hold.

```
gms/
├─ package.json              # type: module, engines: node >=22
├─ tsconfig.json             # strict, NodeNext, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├─ .dependency-cruiser.cjs   # core ↛ automations, db ↛ cli, …
├─ gms.config.yaml           # committed defaults (gms.config.local.yaml is gitignored)
├─ .env.example
├─ Dockerfile                # Playwright base image — Linux only, optional
├─ drizzle/                  # committed SQL migrations
├─ fixtures/                 # frozen place-page HTML + XHR bodies for extractor tests
├─ blocklists/               # email-domains.txt, tlds.txt (IANA), suppressions.txt
├─ data/                     # RUNTIME, gitignored: gms.sqlite, artifacts/, logs/, exports/, profiles/
└─ src/
   ├─ index.ts               # the public surface the future SaaS API imports
   ├─ config/                # schema.ts (zod) · defaults.ts · loader.ts · env.ts
   ├─ core/                  # ── framework, automation-agnostic ──
   │  ├─ automation/         # types.ts (THE plugin interface) · registry.ts · context.ts
   │  ├─ engine/             # orchestrator · worker-pool · lease · checkpoint · reaper · shutdown
   │  ├─ browser/            # pool · context-factory · humanize · resource-blocker
   │  │                      # block-detector · consent · artifacts
   │  ├─ http/               # client (undici) · rate-limiter · robots · dns-cache
   │  ├─ proxy/              # provider.ts · static-list.ts · gateway.ts · health.ts
   │  ├─ errors/             # taxonomy.ts · retry-policy.ts
   │  ├─ logging/            # logger.ts · run-summary.ts · metrics.ts
   │  └─ util/               # url · phone · text · paths · hash · jitter · tld
   ├─ db/
   │  ├─ client.ts  migrate.ts  schema.ts
   │  └─ repositories/       # jobs · runs · cities · categories · businesses
   │                         # sightings · domains · pages · emails · exports · suppressions
   ├─ automations/
   │  ├─ registry.ts
   │  ├─ google-maps/
   │  │  ├─ index.ts         # implements Automation
   │  │  ├─ config.ts planner.ts search.ts feed.ts place.ts normalize.ts
   │  │  └─ extract/         # from-url · from-xhr · from-dom · merge · health
   │  └─ yellow-pages/       # M7 — proves the interface
   ├─ enrichment/
   │  └─ website-emails/     # crawler · frontier · scoring · fetcher
   │     ├─ extract/         # mailto · jsonld · text · obfuscated · cfemail
   │     └─ validate/        # syntax · tld · junk-rules · mx · confidence
   ├─ exporters/             # types.ts registry.ts cursor.ts · csv/ · sheets/
   ├─ importers/             # cities.ts categories.ts legacy-xlsx.ts
   ├─ views/                 # denormalized export row shapes (lead-flat, business, email)
   └─ cli/                   # main.ts + commands/*
```

### The automation plugin interface

This is the single most important file in the project — everything else is downstream of it.

```ts
// src/core/automation/types.ts

export interface Automation<TConfig = unknown, TRecord = unknown> {
  readonly id: string;                  // 'google-maps' | 'yellow-pages' | 'website-emails'
  readonly displayName: string;
  readonly version: string;             // bump when extraction semantics change
  readonly configSchema: z.ZodType<TConfig>;
  readonly recordSchema: RecordSchema;  // field defs → drives exporters, validation, CSV headers
  readonly requires: {
    browser: boolean;
    http: boolean;
    proxy: 'required' | 'optional' | 'none';
  };

  /** Materialize work units from seed data. Called by `gms plan`. Must be idempotent. */
  plan(input: PlanInput, ctx: PlanContext): AsyncIterable<JobSpec>;

  /** Execute ONE job. Must be resumable from ctx.checkpoint. Must never touch the DB. */
  execute(ctx: AutomationContext): AsyncIterable<Emission<TRecord>>;

  /** Optional: replay fixtures / live smoke test. Powers `gms doctor <automation>`. */
  diagnose?(ctx: DiagnoseContext): Promise<DiagnosticReport>;
}

export type Emission<T> =
  | { kind: 'record';     entity: EntityKind; data: T; dedupKey?: string }
  | { kind: 'link';       from: EntityRef; to: EntityRef; meta?: JsonObject }
  | { kind: 'job';        spec: JobSpec }      // fan-out: enqueue email enrichment
  | { kind: 'checkpoint'; cursor: JsonValue }  // resume point
  | { kind: 'metric';     name: string; value: number }
  | { kind: 'warn';       code: string; detail: JsonObject };

export interface AutomationContext {
  readonly runId: string;
  readonly job: JobRecord;
  readonly config: ResolvedConfig;
  readonly logger: Logger;              // pre-bound: {runId, jobId, workerId, proxyId}
  readonly signal: AbortSignal;         // graceful shutdown
  readonly browser: BrowserLease;       // acquire()/release() a context+page, proxy already bound
  readonly http: HttpClient;            // proxied, rate-limited, retrying, robots-aware
  readonly proxy: ProxySession | null;
  readonly checkpoint: CheckpointStore; // get<T>() / set<T>()
  readonly artifacts: ArtifactWriter;   // screenshot(), html(), trace()
  readonly metrics: MetricSink;
}
```

Four contract rules carry all the leverage:

1. **`execute` yields, never writes.** The engine owns persistence, dedup, upsert, and export fan-out. This is what makes storage genuinely abstract — an automation *cannot* know where data goes.
2. **The engine persists records and the checkpoint in the same SQLite transaction.** That eliminates the "records saved but checkpoint lost" bug class, which is exactly how the legacy system re-scraped businesses under different search terms.
3. **`execute` is idempotent w.r.t. its checkpoint.** Re-entering with the same cursor must not duplicate emissions.
4. **Automations throw typed `AutomationError` subclasses** (`BlockedError`, `SelectorMissError`, …) so the retry policy classifies without string-matching.

Adding Yellow Pages is then one folder, one line in `automations/registry.ts`, and a zod sub-schema — zero engine changes. Website-email enrichment is itself an `Automation` with `requires.browser: false`, which proves the abstraction holds before automation #2 is ever written.

---

## Data model (SQLite)

Pragmas on every connection: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`. WAL needs a real local filesystem — `gms doctor` **refuses to run** if the DB path resolves inside OneDrive / Dropbox / iCloud / a UNC share, which is a very real Windows VPS footgun.

```sql
-- ─── seeds ────────────────────────────────────────────────────────────────
CREATE TABLE cities (
  id INTEGER PRIMARY KEY,
  zip TEXT NOT NULL UNIQUE,          -- re-padded to 5 on import
  city TEXT NOT NULL, state TEXT NOT NULL, state_code TEXT NOT NULL,
  county TEXT, state_fips TEXT, county_fips TEXT,   -- padded to 2 / 3
  lat REAL NOT NULL, lng REAL NOT NULL,
  population INTEGER,                -- optional, drives job priority
  active INTEGER NOT NULL DEFAULT 1, source TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX cities_state_city_idx ON cities (state_code, city);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  aliases TEXT,                      -- JSON array of alternate search terms
  weight REAL NOT NULL DEFAULT 1.0,  -- lead value → job priority
  active INTEGER NOT NULL DEFAULT 1
);

-- ─── runs & work ──────────────────────────────────────────────────────────
CREATE TABLE runs (
  id TEXT PRIMARY KEY,               -- ULID
  automation_id TEXT NOT NULL,
  config_hash TEXT NOT NULL, config_json TEXT NOT NULL,   -- secrets redacted
  host TEXT, pid INTEGER, version TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','aborted','failed')),
  started_at INTEGER NOT NULL, finished_at INTEGER, stats_json TEXT
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  automation_id TEXT NOT NULL,
  task_key TEXT NOT NULL,            -- 'city:12|cat:7'  or  'domain:acme.com'
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','done','failed','skipped','paused')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at INTEGER NOT NULL DEFAULT 0,      -- backoff gate (epoch ms)
  lease_owner TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER,
  last_error TEXT, last_error_kind TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  first_run_id TEXT, last_run_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER,
  UNIQUE (automation_id, task_key)
);
CREATE INDEX jobs_claim_idx ON jobs (automation_id, status, scheduled_at, priority DESC, id);
CREATE INDEX jobs_lease_idx ON jobs (status, lease_expires_at);

CREATE TABLE job_checkpoints (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  cursor_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);

-- ─── entities ─────────────────────────────────────────────────────────────
CREATE TABLE businesses (
  id INTEGER PRIMARY KEY,
  cid TEXT,                          -- decimal Google CID — the stable key
  fid TEXT,                          -- '0x864e…:0x9c9c…'
  place_id TEXT,                     -- ChIJ… when available from XHR
  dedup_hash TEXT NOT NULL,          -- cid, else sha1(name|phone_e164|lat4,lng4)
  name TEXT NOT NULL,
  category_primary TEXT, categories_json TEXT,
  rating REAL, reviews_count INTEGER, price_level INTEGER,
  phone_raw TEXT, phone_e164 TEXT,
  address_raw TEXT, street TEXT, city TEXT, state_code TEXT,
  postal_code TEXT, country TEXT,
  lat REAL, lng REAL, plus_code TEXT,
  website_raw TEXT, website_url TEXT,
  domain_id INTEGER REFERENCES domains(id),
  gmaps_url TEXT, thumbnail_url TEXT, hours_json TEXT,
  permanently_closed INTEGER NOT NULL DEFAULT 0,
  extraction_source TEXT,            -- {"name":"xhr","phone":"dom",…}
  raw_json TEXT,
  automation_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  first_run_id TEXT, last_run_id TEXT
);
CREATE UNIQUE INDEX businesses_cid_idx   ON businesses (cid) WHERE cid IS NOT NULL;
CREATE UNIQUE INDEX businesses_dedup_idx ON businesses (dedup_hash);
CREATE INDEX businesses_domain_idx       ON businesses (domain_id);
CREATE INDEX businesses_geo_idx          ON businesses (state_code, city);

-- Provenance. Fixes "result city ≠ seed city" AND "same business under N search terms".
CREATE TABLE business_sightings (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id), run_id TEXT NOT NULL,
  seed_city_id INTEGER REFERENCES cities(id),
  seed_category_id INTEGER REFERENCES categories(id),
  search_query TEXT NOT NULL, rank_in_results INTEGER, seen_at INTEGER NOT NULL,
  UNIQUE (business_id, job_id)
);

-- ─── website crawl cache (global, cross-city, cross-business) ─────────────
CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,       -- registrable, lowercase, no www
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','crawling','done','failed','skipped','parked')),
  http_status INTEGER, final_url TEXT,
  is_parked INTEGER NOT NULL DEFAULT 0,
  is_social INTEGER NOT NULL DEFAULT 0,        -- facebook.com/… → skip crawl
  is_directory_like INTEGER NOT NULL DEFAULT 0,-- yielded > maxEmailsPerPage
  robots_json TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0, bytes_fetched INTEGER NOT NULL DEFAULT 0,
  emails_found INTEGER NOT NULL DEFAULT 0, used_js_fallback INTEGER NOT NULL DEFAULT 0,
  last_crawled_at INTEGER, next_eligible_at INTEGER, error TEXT
);
CREATE INDEX domains_status_idx ON domains (status, next_eligible_at);

CREATE TABLE pages (                 -- config-gated; disk footprint
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  url TEXT NOT NULL, depth INTEGER NOT NULL, score REAL,
  status_code INTEGER, content_hash TEXT, bytes INTEGER,
  emails_found INTEGER NOT NULL DEFAULT 0, fetched_at INTEGER, error TEXT,
  UNIQUE (domain_id, url)
);

-- ─── emails: one row per address. NEVER comma-joined. ─────────────────────
CREATE TABLE emails (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,      -- lowercased, punycode-normalized
  local_part TEXT NOT NULL, email_domain TEXT NOT NULL,
  is_role INTEGER NOT NULL DEFAULT 0,   -- info@, sales@, …
  is_free INTEGER NOT NULL DEFAULT 0,   -- gmail/yahoo/outlook
  is_junk INTEGER NOT NULL DEFAULT 0, junk_reason TEXT,
  mx_valid INTEGER, mx_checked_at INTEGER, first_seen_at INTEGER NOT NULL
);
CREATE INDEX emails_domain_idx ON emails (email_domain);

CREATE TABLE business_emails (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL, source_domain_id INTEGER REFERENCES domains(id),
  method TEXT NOT NULL,              -- mailto|jsonld|text|obfuscated|cfemail
  confidence REAL NOT NULL,          -- 1.0 same-domain … 0.4 off-domain
  page_depth INTEGER, first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, email_id)
);

CREATE TABLE suppressions (          -- compliance: unsubscribe / DNC
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','domain','phone','cid')),
  value TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE export_cursors (        -- watermarks, so exports resume not restart
  exporter TEXT NOT NULL, target TEXT NOT NULL, entity TEXT NOT NULL,
  last_id INTEGER NOT NULL DEFAULT 0, last_at INTEGER,
  rows_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (exporter, target, entity)
);

CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
```

### Leasing and crash recovery

Atomic claim in one statement — no `BEGIN IMMEDIATE` dance:

```sql
UPDATE jobs
   SET status='leased', lease_owner=:owner, lease_expires_at=:now + :leaseMs,
       heartbeat_at=:now, attempts=attempts+1,
       started_at=COALESCE(started_at,:now), last_run_id=:runId, updated_at=:now
 WHERE id = (SELECT id FROM jobs
              WHERE automation_id=:automationId AND status='pending' AND scheduled_at<=:now
              ORDER BY priority DESC, scheduled_at ASC, id ASC LIMIT 1)
RETURNING *;
```

- **Heartbeat** — each worker bumps `lease_expires_at` every `heartbeatSeconds`; a long job is fine as long as the process lives.
- **Reaper** (startup + every 60 s) — `UPDATE jobs SET status='pending', lease_owner=NULL, last_error_kind='lease_expired', scheduled_at=:now WHERE status='leased' AND lease_expires_at < :now`. This is the crash-recovery path: `kill -9`, power loss, and VPS reboot all converge here.
- **Mid-job resume** — `job_checkpoints.cursor_json` holds `{ phase, collectedPlaceUrls[], processedIndex, scrollRounds }`. Records and checkpoint commit in one transaction, so a job killed at listing 73/120 resumes at 73 with no re-scrolling and no duplicates.
- **Backoff** — on failure: `status='pending'`, `scheduled_at = now + base · factor^attempts · jitter`. At `attempts >= max_attempts` → `failed`, recoverable only via `gms jobs retry`.
- **Multi-process safety is free.** WAL plus the atomic claim means two `gms run` processes against one DB work today; swapping the repository to Postgres (`FOR UPDATE SKIP LOCKED`) gives multi-machine tomorrow.

**Verified implementation rules — these are correctness requirements, not style preferences.** The atomicity of the claim was confirmed at the bytecode level (`EXPLAIN` shows `Transaction 0 1 1` as the first opcode, before the subquery's `OpenRead`, so the write lock and read snapshot are taken together — there is no read-then-write race). But that guarantee is conditional:

1. **Add a fencing token.** `lease_epoch INTEGER NOT NULL DEFAULT 0`, incremented by *both* the claim and the reaper. Every heartbeat / progress / complete / fail statement must carry `WHERE id=:id AND lease_owner=:owner AND lease_epoch=:epoch` and the worker must abort and discard side effects when `changes === 0`. **Without this the reaper will eventually let two workers run the same job concurrently and both write results** — the exact duplicate-row disease the legacy system had, reintroduced by the recovery mechanism.
2. **Invoke the claim with `.get()`, never `.run()`.** `better-sqlite3`'s `.run()` steps once and returns only `{changes, lastInsertRowid}` — it silently discards `RETURNING` rows. `.run()` would lease a job and throw away its identity. Treat `undefined` as "queue empty".
3. **Never wrap the claim in `db.transaction(...)` or an explicit `BEGIN`.** Its atomicity comes from the implicit autocommit write transaction. A deferred `BEGIN` with any preceding `SELECT` creates a read→write promotion that fails with `SQLITE_BUSY_SNAPSHOT` — and the busy handler is *not* invoked for that code, so `busy_timeout` will not retry it. If a multi-statement claim ever becomes necessary, use `.immediate()`.
4. **Do not set `busy_timeout=5000` on the claim path.** `better-sqlite3` already defaults to 5000, and the default busy handler *sleeps the calling thread* — under contention that stalls the entire event loop (all workers, all timers, the heartbeat) for up to five seconds. Use 50–250 ms plus application-level retry with jitter, and treat `SQLITE_BUSY` as a normal expected outcome.
5. **One connection per thread.** N async workers in one thread share exactly one connection (safe without a mutex — the synchronous API serializes them). Real `worker_threads` open one connection *inside* each worker; a connection or prepared statement must never cross threads. Never let a transaction or an open `.iterate()` span an `await` on a shared connection.
6. **Index the claim's subquery** — a partial index on `(automation_id, scheduled_at, priority) WHERE status='pending'`. The subquery runs while holding the global write lock, so a full scan there serializes the whole system.
7. **The heartbeat must tolerate event-loop starvation.** A `setInterval` heartbeat cannot fire while a synchronous DB call blocks the loop. Set the lease generously longer than p99 job duration, extend it via the fenced conditional update, accept at-least-once, and make all job side effects idempotent.
8. **Guard the DB path at startup.** Refuse a UNC path or mapped network drive outright — SQLite states verbatim that WAL does not work over a network filesystem. For OneDrive/Dropbox the risk is different and needs different wording: those are local filesystems where WAL *does* work, but background sync agents snapshot mid-transaction and sync `-wal`/`-shm` independently of the main file, producing corrupt copies. Recommend storing the DB outside synced folders and using `VACUUM INTO` for backups.

### Legacy migration

`gms import legacy <xlsx>` re-pads zips and FIPS codes, converts the two 1-D DONE columns into `jobs` rows, and imports the 438 result rows into `businesses` + `business_sightings` deduped by CID (the 126 CID-less rows fall back to `dedup_hash`). Comma-joined email cells are split, junk-filtered, and normalized. Because the legacy service DONE column was *global across cities*, the honest import marks city-level completions as `skipped` with a note and leaves everything else `pending` — it does not invent per-`(city, category)` completion that the source data never recorded.

---

## Google Maps pipeline

**S0 — Lease & identity.** Claim job → acquire `ProxySession` → acquire browser context (`newContext({ proxy, locale: 'en-US', timezoneId, viewport: randomized })` with fingerprint injection). Reuse `storageState` per proxy identity so consent cookies persist. Recycle the context after `jobsPerContext` jobs.

**S1 — Consent.** Detect the `consent.google.com` interstitial → click *Reject all* (fewer cookies, same outcome) → persist `storageState` keyed by proxy id. Two consecutive failures to clear ⇒ `BlockedError`, burn the identity.

**S2 — Search.** Pin locale on every URL (`&hl=en&gl=us`). Two modes:
- `query` (**default**) — `https://www.google.com/maps/search/{encoded}?hl=en&gl=us`. One navigation, deterministic, no typing, no searchbox selector dependency. Template configurable, default `"{category} in {city}, {stateCode}"`.
- `coordinates` — `https://www.google.com/maps/@{lat},{lng},{zoom}z?hl=en&gl=us`, then fill `#searchboxinput` (fallbacks `input[name="q"]`, `[role="combobox"]`) + Enter. Matches what RTILA did; use for tight geographic control.

Neither mode stops Google returning metro-area businesses. That is not a query-time bug to fix — it is **provenance to record** (`business_sightings.seed_city_id` vs `businesses.city`), with an optional `filters.stateMustMatchSeed` post-filter.

**S3 — Feed harvest.** Find the scroll container via `div[role="feed"]`, falling back to programmatically locating the nearest scrollable ancestor of the first `a[href*="/maps/place/"]` — a self-healing fallback that survives one class of DOM change. Loop: capture hrefs → `mouse.wheel` with randomized delta and pause → repeat. **Termination, first to fire:**
1. `maxListingsPerJob` reached — stop mid-round, immediately;
2. end-of-list sentinel present (locale pinned, so text matching is safe), plus the structural end block;
3. `maxIdleRounds` consecutive rounds yielding no *new unique* place URLs (not `scrollHeight` — Maps virtualizes the list);
4. `scroll.maxRounds` hard ceiling;
5. per-job time budget.

Checkpoint after every round with the ordered unique URL list.

**S4 — Detail extraction — three channels, merged, with recorded provenance.** Do **not** open a tab per listing (the legacy design); navigate the same page, or click the feed item, which is cheaper still.

1. **URL channel** (never breaks) — parse `!1s(0x[0-9a-f]+:0x[0-9a-f]+)` → `fid`; derive `cid`; coordinates from `!3d…!4d…` or `@lat,lng,z`. Also honor `?cid=` and `ludocid`. *This is the dedup key the legacy system threw away.*
2. **XHR channel** (primary for fields) — register `page.on('response')` before navigation, capture bodies from Maps' internal place/search endpoints, strip the `)]}'` prefix, read positionally through a total-function accessor that returns `undefined` rather than throwing.
3. **DOM/ARIA channel** (fallback + cross-check) — `h1` for name, `[data-item-id="address"]`, `[data-item-id^="phone:tel:"]` (the number is *in the attribute*, parse it rather than reading text), `[data-item-id="authority"]` for website, `[data-item-id^="oh"]` for hours, the rating/review `aria-label`s. `data-item-id` is semantic and far more stable than the hashed `.lfPIob` / `.fontDisplayLarge` classes the old flow depended on.

Merge by configured channel priority; store per-field source in `extraction_source`.

**Corrections from verification — several of these are silent-corruption bugs, not style notes:**

- **The website field is a Google redirect, not the target URL.** The XHR value looks like `/url?q=http://realsite.com/&opi=…&usg=…`. You must parse the `q=` parameter. Feeding the raw value into the email crawler would send every single request to `google.com` — a pipeline that looks like it works while producing zero emails.
- **Store CID as a TEXT/string everywhere** — DB column, JSON, CSV, Sheets. It is an unsigned 64-bit value (e.g. `10281119596374313554`) that exceeds JavaScript `Number` precision and goes negative under signed parsing. Use `BigInt` at the parse site. This is painful to reverse after the first large run.
- **`place_id` is derivable offline from the fid** — no Places API dependency is needed to obtain it, and `/maps/preview/place` returns it directly. Keep CID as the internal primary key, since Google documents that `place_id` can change.
- **Drop bare `h1` for the business name.** Result cards and the place panel both emit `h1`, and the feed stays in the DOM behind the open panel — `page.locator('h1')` matches multiple nodes and can attribute one business's name to another's record. Take the name from the XHR payload, or scope to `div[role='main'][aria-label]` and read the aria-label.
- **`hl=en` must be a non-overridable constant in the fetcher, not a config knob.** Three separate mechanisms silently depend on it: the rating's `aria-label*="star"` (renders "étoiles" under `hl=fr`), the end-of-list sentinel text, and the consent button labels. Verification observed Google serving a French bundle unprompted from a US-looking request, so this is a live failure mode. *(Since the Gobadiz campaign: only the region `gl` and the query template are configurable, under `market`. The interface stays English everywhere, Google's English category names are mapped to a campaign's own words by its qualification rules, and the consent and block detectors also know the French labels as a safety net.)*
- **Make count-stagnation the primary end-of-scroll signal** (listing-anchor count unchanged across N scroll+settle cycles), with sentinel text and the hard cap as secondary exits. No stable class or structure for the sentinel node could be verified in the current build, so it must not be the sole termination condition.
- **The ~120 result cap is per viewport, not per city.** Dense city/category pairs are silently truncated with no error. Add tile/grid decomposition to the planner — a `tiles` table keyed by `(city, tile)`, deduped across tiles on CID. The Cities sheet already carries lat/lng, so this is cheap to add and expensive to retrofit.
- **Consent handling needs three specific hardenings:** treat the consent screen as *optional* (verification observed a run auto-redirecting back with `?ucbcb=1` and no button at all, so waiting on the button will hang); key cached `storageState` by *(proxy exit country, google host)* because the cookie is per-registrable-domain and the wall is triggered by IP geolocation; and never hardcode a consent cookie value copied from a blog — it embeds a Google build label and will rot. Run the reject-all flow once per exit and cache the result.
- **Ban obfuscated class tokens in production selector code** with an actual lint rule or test. Tokens like `DUwDvf`, `Nv2PK`, `qBF1Pd`, `hfpxzc` are compiler-generated and rotate; ARIA roles and `data-item-id` literals are hardcoded in Google's source and have held for roughly three years.
- **Reframe the "XHR rots more slowly" premise.** It is true on *rate* but wrong on *failure mode*: a rotted CSS selector throws, while a rotted array index returns null. Live payload indices have already moved during 2026. This is why per-field null-rate monitoring with a halt threshold is a **first-class M3 deliverable, not an observability nice-to-have** — otherwise the first schema drift yields tens of thousands of silently blank website rows, and website is the sole input to the entire email stage.

**S5 — Normalize & upsert.** Phone → E.164; address → components; website → strip tracking params, resolve registrable domain via `tldts`, and reject `google.com` / `facebook.com` / `instagram.com` as "websites" (flag the domain `is_social` instead). Upsert on `cid`, else `dedup_hash`. Always insert a `business_sightings` row.

**S6 — Fan-out.** For each new or stale `domains` row (respecting `next_eligible_at`), emit `{kind:'job', spec:{automationId:'website-emails', taskKey:'domain:acme.com'}}`. The engine dedups on `(automation_id, task_key)`, so a franchise's shared site becomes exactly one crawl job globally.

### Defending against selector rot

Three layers, because this *will* happen — budget one maintenance touch per quarter:

- **CI fixtures.** `fixtures/` holds frozen place-page HTML and XHR bodies; extractor unit tests run on every commit, so rot is usually caught before a run.
- **Live fill-rate guards.** Per run, track fill rate per field over a rolling sample. If `name` drops below 95%, or any field falls more than `minFillRateDelta` below the trailing baseline in `runs.stats_json`, the run **aborts** with `SELECTOR_ROT_SUSPECTED` and dumps a screenshot plus trimmed HTML. Failing loudly beats writing 40,000 rows of nulls — which is precisely what the legacy system did.
- **`gms doctor google-maps`.** Replays fixtures, optionally runs one live job, and prints a per-field, per-channel fill table.

### Humanization, rate limiting, proxies

Token bucket **per proxy identity**; log-normal jittered delays (never a fixed `waitForTimeout` — always wait on a condition with a timeout ceiling); `mouse.wheel` with varying deltas; randomized viewport within a plausible band; `page.route` blocking `image`/`media`/`font` (3–5× faster and a large bandwidth saving on metered residential proxies — keep CSS and JS, Maps needs them).

Block detection: redirect to `/sorry/index`, HTTP 429, consent loop, empty feed while sibling queries succeed, `about:blank` after navigation. Response: mark the identity burned for `banCooldownSeconds`, release the job to `pending` with backoff, rotate identity, and apply **AIMD concurrency** — additive increase on clean jobs, multiplicative decrease when the rolling block rate crosses `blockRateThreshold`.

```ts
interface ProxyProvider {
  acquire(purpose: 'browser' | 'http'): Promise<ProxySession | null>;
  release(s: ProxySession, outcome: 'ok' | 'blocked' | 'error' | 'timeout'): void;
  health(): ProxyHealthReport[];
}
```

Implementations: `NoProxy`, `StaticList` (file of `host:port:user:pass`, least-recently-used with health weighting and cooldown), `RotatingGateway` (single endpoint, sticky sessions encoded in the username, `sessionTtlSeconds`). `gms doctor --proxies` hits an IP-echo endpoint through every proxy and reports egress IP, geo, and latency, marking dead entries.

**Playwright proxy rules, corrected by verification** (an earlier draft of this plan had a bug here that would have broken every non-proxied context):

- **Never set a launch-level `proxy: { server: 'per-context' }`.** It is unnecessary on Playwright ≥1.47 and it is *not* harmless: every context that does not override the proxy inherits `--proxy-server=http://per-context` and dies with `ERR_PROXY_CONNECTION_FAILED`, and the auto-added `--proxy-bypass-list=<-loopback>` forces localhost traffic through the proxy too. Launch with plain `chromium.launch()` and set the proxy per context.
- **Pin `playwright >= 1.47`** explicitly rather than using a caret range across that boundary.
- **Proxy credentials go in the separate `username` / `password` fields, never as `user:pass@` userinfo in the server URL** — Playwright rebuilds `server` from protocol + host and silently drops the userinfo, so a URL-embedded sticky-session token authenticates as nobody.
- **Sticky-session gateways must be `http://` or `https://`, not `socks5://`.** Playwright throws on SOCKS with credentials, which makes username-encoded sticky sessions impossible over SOCKS.
- **Make the session-token username format a per-provider config value**, not a hardcoded `-session-` string — Bright Data and Oxylabs use different schemes. Confirm the exact token with whichever provider you buy.
- **There is no `setProxy` API.** Rotation means context-per-identity: `newContext({ proxy })` → use → `close()`. Budget for re-seeding cookies via `storageState` on each rotation.
- Proxy credentials are promoted into the context's `httpCredentials`, so they are also offered against site-level 401 challenges. Scope them, or expect the proxy username to leak to any origin issuing HTTP Basic auth.

### Capacity — why this design, in numbers

185 cities × 85 categories = **15,725 jobs**, ~60 listings each ⇒ ~940k listing views. The legacy path (1 thread, fixed 15–30 s waits, tab per listing, inline crawl) is months. With resource blocking, same-page navigation, and the XHR channel, ~2.5–3.5 s per listing per worker; at 6 browser workers that is **≈5–6 days** of Maps extraction. Email enrichment is decoupled and HTTP-only, running *concurrently*. A full sweep is a **1–2 week wall-clock job**, and `jobs.priority = f(city.population, category.weight)` puts the highest-value leads in the first 48 hours.

---

## Email crawling pipeline

**Architectural call: this is a separate automation with its own domain-keyed job queue, not an inline step inside the Maps job.** Four reasons: global domain-level dedup (a chain's site is crawled once across all 185 cities); independent concurrency (20 HTTP workers vs. 4 browser workers); a slow or dead website never stalls a browser context; and you can re-run enrichment with better rules without re-scraping Maps.

**Fetch.** `undici` with a per-host `Pool`, keep-alive, gzip/br, bounded redirects, `timeoutMs`, `maxBodyBytes` (2 MB), content-type allowlist, UA from a pool. `robots.txt` fetched once per domain and respected by default, honoring `Crawl-delay`. Per-host concurrency 2 with jittered inter-request delay.

**Discovery order** — cheapest and highest-yield first:
1. Landing page
2. `sitemap.xml` — scan URLs for contact/about patterns; an enormous win for one request
3. `mailto:` hrefs anywhere — instant, highest confidence
4. JSON-LD `Organization`/`LocalBusiness`.`email`, microdata, `<address>`
5. Scored link frontier

**Link scoring** replaces the legacy's *randomized* link selection — the single worst decision in the old crawler:

```
score = 5.0 · pathKeywordHit(contact|contact-us|about|about-us|team|our-team|staff|
                             people|impressum|kontakt|support|legal|privacy)
      + 3.0 · anchorTextHit(same set, case-insensitive)
      + 1.0 · isNavOrFooterLink
      - 1.5 · depth
      - 2.0 · pathHit(blog|news|product|shop|cart|category|tag|archive|\d{4}/\d{2})
      - 3.0 · hasPagination(page=|/page/\d+)
      - 5.0 · mediaExtension | /wp-content/ | /wp-json/
      - 2.0 · queryParamCount > 1
```

Max-heap frontier per domain, bounded by `maxDepth` (0 / 1 / 2 / `null` = unlimited), `maxPages`, `maxTimePerDomainMs`, `maxBytesPerDomain`. Unlimited depth is *still* bounded by pages/time/bytes, so there is no runaway. Same registrable domain by default, `www` normalized, fragments and tracking params stripped, content-hash dedup so `/contact` and `/contact/` don't both count.

**JS fallback.** If zero emails and the rendered text is suspiciously short (or an empty SPA root is detected), requeue the domain as a `render:playwright` sub-task using the shared browser pool, capped by `jsFallback.budgetPerRun`.

**Extraction.** `mailto:` (URL-decode, strip `?subject=`) · JSON-LD · Cloudflare `data-cfemail` decode · HTML entity decode (`&#64;`, `&commat;`) · obfuscation patterns (`(at)`, `[at]`, ` AT `, `(dot)`, `[dot]`) · regex over text **after stripping `<script>`/`<style>`/`<noscript>` and after removing `src`/`srcset`/`href` attribute values**. That last preprocessing step alone kills the `logo@2x.jpg` and Sentry-DSN pollution at the source.

**Validation and junk rules**, ordered, each recording a `junk_reason`:

| # | Rule | Kills (observed in your 438 rows) |
|---|---|---|
| 1 | Syntax, length, punycode normalize, lowercase, strip trailing punctuation | — |
| 2 | TLD must be in the bundled IANA list | `logo@2x.jpg`, `icon@2x.png` |
| 3 | Reject asset extensions in the domain part | image filenames |
| 4 | Reject if the match sits inside a URL | Sentry DSNs |
| 5 | Vendor/telemetry blocklist (`sentry.io`, `*.wixpress.com`, bugsnag, newrelic) + placeholders (`example.com`, `yourdomain.com`) | `sentry-next.wixpress.com` |
| 6 | Hash-like local part (hex ≥ 16 chars) | Sentry public keys |
| 7 | Filename-like local part (`logo`, `icon`, `bg`, `sprite`, `hero`) with `@2x`/`@3x` | image junk |
| 8 | Role classification → keep, flag `is_role` | — |
| 9 | Domain-relevance confidence: same registrable domain 1.0 · free provider 0.7 · other corporate domain 0.4 + `off_domain` | — |
| 10 | `maxEmailsPerPage` (5) / `maxEmailsPerDomain` (25); exceeding marks the domain `is_directory_like` and keeps top-N by score | **the 67-address `cau.edu` flood** |
| 11 | Optional `dns.resolveMx` with LRU cache. **Never SMTP-probe** — it blacklists your IPs | — |

One row per address in `emails`, one link row in `business_emails`. Exporters flatten on the way out (`emailJoin: rows | csv | columns`), so the comma-joined-cell format stays available for Sheets without corrupting the database.

---

## Storage abstraction

**Principle: SQLite is written first, always. Exporters are cursor-driven subscribers.** An exporter failure therefore cannot lose data and can always catch up — precisely the failure mode the legacy Apps Script had, where a failed Sheets write silently dropped a listing forever.

```ts
export interface Exporter<TRow = Record<string, unknown>> {
  readonly name: string;
  readonly capabilities: { append: boolean; upsert: boolean; batchSize: number };
  init(ctx: ExporterContext): Promise<void>;
  ensureSchema(schema: RecordSchema): Promise<void>;    // headers / sheet / table
  write(rows: TRow[], ctx: WriteContext): Promise<WriteResult>;  // idempotent on row.rowUid
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Two drive modes on one interface: **streaming** during a run (`flushEveryN` / `flushEveryMs`) and **batch** via `gms export …`, replaying from the `export_cursors` watermark. Row shapes live in `src/views/` (`lead-flat`, `business`, `email`) so every exporter agrees on columns.

**CsvExporter** — streaming `csv-stringify`, header on file creation, `\n` normalized explicitly (never platform-dependent), optional UTF-8 BOM for Excel, `splitBy: none|state|run`. Numeric-looking fields (zip, phone, FIPS) quoted as text.

**SheetsExporter** — service-account auth; share the target sheet with the service-account email. Writes go through batched appends with `valueInputOption: 'RAW'` — non-negotiable, because value coercion is exactly how the legacy sheet lost the leading zeros on zips and FIPS codes. Exponential backoff with jitter on 429/503, an in-process mutex so concurrent workers never interleave appends, `export_cursors.last_id` advanced only after a confirmed success, and a `row_uid` column so a duplicated append is detectable and removable.

**Sheets is a capped convenience export, not the primary large-export path.** Verification corrected several assumptions here:

- **It does not fit at full scale.** ~1M business rows × 15–25 columns is 15–25M cells against a hard 10M-cell-per-file ceiling. Hard-cap the Sheets path at a configurable row count (50k–100k) with an explicit user-facing error above it, or auto-shard across spreadsheets with a manifest sheet. CSV stays the primary bulk path.
- **60 writes/min is the absolute ceiling.** A single service account *is* the user, so the 300/min/project quota is unreachable without sharding across multiple service accounts. Size export ETAs against 60/min.
- **Batch, because each `batchUpdate` costs exactly one of those 60 writes** regardless of how many subrequests it carries — that is an N× quota multiplier, not a micro-optimization. Prefer `spreadsheets.batchUpdate` + `appendCells` over repeated `values.append`. For one-shot bulk loads, a Drive `files.create` resumable CSV upload creates the whole sheet in one call and consumes zero Sheets write quota.
- **`valueInputOption: RAW` alone does not protect leading zeros.** The coercion usually happens client-side in the CSV/JSON parser before the API is ever called. Carry zip/phone/postal/ID fields as JSON strings end-to-end; for a hard guarantee use `appendCells` with `userEnteredValue.stringValue` per cell.
- Chunk by serialized byte size (~1–2 MB), not a fixed row count, to respect the 180-second per-request processing timeout.
- **Service-account keys may be blocked outright.** The `iam.disableServiceAccountKeyCreation` org policy is enforced by default for GCP orgs created on or after 2024-05-03. Offer keyless auth (ADC / Workload Identity Federation) as the preferred path and the JSON key as fallback.
- Depend on `@googleapis/sheets`, not the full `googleapis` metapackage, and do not add a mismatched `google-auth-library` alongside it.

**The Apps Script proxy is deleted, not ported.** It was a public read/write endpoint to your data with cell-by-cell writes.

Note the distinction that keeps the abstraction honest: swapping *state* from SQLite to Postgres is a **repository** change, not an exporter change. Exporters are for delivering results outward; the repository layer is for owning state.

---

## Configuration

Layering: **defaults → `gms.config.yaml` → `gms.config.local.yaml` → env (`GMS_` prefix, `GMS_BROWSER__HEADLESS=false` dot-path mapping) → CLI flags.** One zod schema validates into one frozen `ResolvedConfig`, hashed into `runs.config_hash`. Secrets live only in env and are redacted by the logger. YAML, because an 80-key config needs comments.

```yaml
project:   { name, dataDir, timezone }
database:  { driver: sqlite|postgres, file, walMode, busyTimeoutMs }
runtime:   { workers, httpWorkers, maxJobsPerRun, jobLeaseSeconds, heartbeatSeconds,
             shutdownGraceSeconds,
             adaptiveConcurrency: { enabled, min, max, blockRateThreshold } }
browser:   { engine, headless, channel, executablePath, slowMoMs,
             viewport: {width:[min,max], height:[min,max]}, locale, timezoneId,
             userAgent: auto|string|poolFile,
             fingerprint: { enabled, devices, os },
             blockResources: [image, media, font],
             contextsPerBrowser, jobsPerContext,
             navigationTimeoutMs, actionTimeoutMs, storageStateDir,
             artifacts: { onFailure: [screenshot, html], trace: off|onFailure, retainDays } }
proxy:     { mode: none|list|gateway, country,
             list:    { file, strategy, cooldownSeconds },
             gateway: { server, username, password, sticky, sessionParam, sessionTtlSeconds },
             healthCheckUrl, maxConsecutiveFailures, banCooldownSeconds }
http:      { userAgents, timeoutMs, maxRedirects, maxBodyBytes, concurrencyPerHost,
             perHostDelayMs:[min,max], respectRobots,
             retries: { attempts, backoffMs, backoffFactor, jitter } }
humanize:  { enabled, delayBetweenListingsMs:[min,max], delayBetweenJobsMs:[min,max],
             scroll: { stepPx:[min,max], pauseMs:[min,max] }, typingDelayMs:[min,max] }

automations.googleMaps:
  { enabled, searchMode: query|coordinates, queryTemplate, zoom, hl, gl,
    maxListingsPerJob,
    scroll: { maxRounds, maxIdleRounds, stopOnEndOfList, timeBudgetMs },
    extraction: { channels:[xhr,dom,url], requireFields:[name],
                  captureHours, captureReviewsCount, capturePhotos },
    filters: { requireWebsite, stateMustMatchSeed, excludePermanentlyClosed },
    onSelectorMiss: warn|fail-job|abort-run,
    healthGuards: { minNameFillRate, minFillRateDelta, sampleSize } }

enrichment.websiteEmails:
  { enabled, maxDepth, maxPages, maxTimePerDomainMs, maxBytesPerDomain,
    followSubdomains, useSitemap, priorityPaths[], stopAfterEmails,
    maxEmailsPerPage, maxEmailsPerDomain, recrawlAfterDays,
    jsFallback: { enabled, budgetPerRun, triggerTextLengthBelow },
    validation: { tldAllowlist, verifyMx, dropRoleAddresses,
                  offDomainConfidence, freeProviderConfidence, blocklistFile } }

exporters: { enabled: [csv],
             csv:    { dir, entity, emailJoin, splitBy, bom },
             sheets: { spreadsheetId, sheetName, credentials, batchSize,
                       valueInputOption: RAW, createIfMissing } }
retries:   { job: {maxAttempts, backoffMs, backoffFactor, jitter},
             navigation: {maxAttempts}, blockedBackoffMs }
logging:   { level, pretty: auto, file, redact[] }
```

---

## CLI surface

```
gms init [--profile <name>]                    scaffold config + data dir
gms doctor [--proxies] [--sheets] [--browsers] env, native modules, playwright,
                                               db path safety, proxy egress IPs, SA auth
gms doctor <automation>                        fixture replay + per-field fill report

gms import cities <file> [--sheet Cities] [--map zip=ZipCode,...]
gms import categories <file>
gms import legacy <xlsx>                       one-shot migration of 438 rows + DONE flags

gms plan [--automation google-maps] [--cities <filter>] [--categories <filter>]
         [--limit N] [--priority-by population,weight] [--dry-run]

gms run  [--automation google-maps] [--workers N] [--max-jobs N] [--headful]
         [--profile <name>] [--dry-run] [--until <duration>]
gms enrich emails [--workers N] [--limit N] [--recrawl]

gms status [--watch] [--json]                  jobs by status, throughput, ETA, block rate
gms jobs list|show <id>|retry|reset|skip|prioritize  [--status failed] [--error-kind blocked]

gms export csv    [--entity leads-flat|businesses|emails] [--since <id|date>] [--full]
gms export sheets [--entity ...] [--full]

gms db migrate|status|vacuum|backup <path>
gms config show [--resolved] [--redact]
```

`run` and `enrich` install `SIGINT` / `SIGTERM` / `SIGBREAK` handlers: stop leasing, let in-flight jobs finish within `shutdownGraceSeconds`, checkpoint, close browsers, flush exporters, mark the run `aborted`. A second Ctrl-C force-exits — and the reaper still recovers everything on next start.

---

## Error handling and observability

Every error is classified into exactly one class, and the class alone determines behavior:

| Class | Examples | Retry | Backoff | Burns proxy | Effect |
|---|---|---|---|---|---|
| `TransientNetwork` | ECONNRESET, socket timeout, 502/503 | yes, 3× | 1 s ×2 | no | item-level |
| `RateLimited` | 429, quota | yes | 5 min | yes | job requeued |
| `Blocked` | `/sorry/index`, captcha, consent loop | yes | `blockedBackoffMs` | yes | job requeued, concurrency ↓ |
| `NavigationTimeout` | page load timeout | yes, 2× | 10 s | after 2 | item, then job |
| `SelectorMiss` | all channels null for a required field | no | — | no | warn or fail per `onSelectorMiss`; trips health guard |
| `ParseError` | XHR shape changed | no | — | no | fall back to DOM channel + warn |
| `PermanentTarget` | 404, NXDOMAIN, parked domain | no | — | no | mark domain `failed`, done |
| `ConfigError` | bad zod validation, missing creds | no | — | — | fail fast at startup |
| `Fatal` | disk full, DB corrupt | no | — | — | abort run cleanly |

**Logging** — `pino` NDJSON to `data/logs/{runId}.ndjson`, pretty transport when TTY. Every line carries `{runId, jobId, workerId, proxyId, automationId}`. Redaction paths configured for proxy passwords and service-account credentials.

**Artifacts** — on any job failure, write `screenshot.png` + trimmed `page.html` (+ trace if enabled) to `data/artifacts/{runId}/{jobId}/`, pruned after `retainDays`. Keep directory names short; Windows path limits are real.

**Run summary** (printed and stored in `runs.stats_json`) — jobs done/failed/skipped · listings seen vs. extracted · new businesses vs. duplicates vs. updates · selector-miss counts per field · domains crawled/cached/skipped · pages fetched · emails found and junked by reason · blocks per proxy · avg s/listing · p50/p95 job duration · bytes through proxies.

**Testing** — unit (extractors against `fixtures/`, junk rules against a hand-labeled email corpus, config layering); integration (8 concurrent workers proving zero double-lease; `kill -9` mid-job proving resume; Sheets exporter against a mock with injected 429s); nightly live smoke (one job, alarm on fill-rate drop). CI matrix ubuntu + windows + macos, unit and integration only — no live scraping in CI.

---

## Roadmap — 8 shippable milestones

Each is independently production-ready and committed as one logical module.

**M0 — Foundation.** *(starting now)*

Deliverables:
1. `git init`, `package.json` (`type: module`, `engines: {node: ">=24.15.0"}`), `tsconfig.json` (strict, NodeNext, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint + Prettier, `dependency-cruiser` boundary rules, `vitest`, `.gitignore` covering `data/` and `*.local.yaml`.
2. `src/config/` — zod schema for the full config surface, layered loader (defaults → `gms.config.yaml` → `gms.config.local.yaml` → `GMS_*` env → CLI flags), frozen `ResolvedConfig`, config hashing, secret redaction.
3. `src/core/logging/` — pino logger with pretty-on-TTY and the redaction paths wired.
4. `src/db/` — the **driver adapter** (pragma/transaction/backup behind one interface), `better-sqlite3` client with WAL pragmas, migration runner, `schema_migrations`, and the repository *interfaces* (no automation-specific repos yet).
5. `src/cli/` — `init`, `doctor`, `config show`, `db migrate`.
6. `doctor` checks: Node version floor, native module actually loaded (with a clear preflight error on unsupported platform triples rather than a raw module-load stack trace), Playwright presence, writable data dir, and the DB path guard (refuse UNC/mapped network drives; warn on cloud-sync folders).

*Done when:* `doctor` is green on macOS, Windows (a clean VPS with no build tools), and Linux; migrations are idempotent and re-runnable; every config key has a schema test; `doctor` refuses a DB path on a network share; `npm test` passes on the CI matrix.

*Explicitly out of scope for M0:* browsers, proxies, automations, exporters, importers, and any `jobs` table logic. Those are M1+.

**M1 — Seeds + job engine.** Importers (xlsx/csv → cities/categories with zip and FIPS zero-pad repair), `plan`, `status`, atomic leasing, heartbeat, reaper, checkpoint API, a fake automation for tests.
*Done when:* 185 cities + 85 categories import with zips as `01234`; `plan` produces 15,725 jobs and is idempotent on re-run; 8 concurrent workers over 10k jobs yield zero double-leases; `kill -9` mid-run reclaims every lease and resumes from checkpoint.

**M2 — Browser engine + proxies.** Browser/context pool, fingerprint + locale + viewport randomization, resource blocking, humanized actions, consent handling, block detection, AIMD hooks, `ProxyProvider` implementations, artifact writer.
*Done when:* `doctor --proxies` prints egress IP/geo/latency per proxy and marks dead ones; an injected 429 triggers cooldown + rotation + backoff; headful and headless both work on Windows; contexts recycle without leaking processes over a 1000-job soak.

**M3 — Google Maps automation.** Search modes, feed scroll + termination, three-channel extraction and merge, normalization, upsert/dedup, sightings, domain fan-out, fixture suite, health guards.
*Done when:* 5 cities × 3 categories run live; ≥95% name/address fill, ≥99% CID capture; zero duplicate CIDs in `businesses`; killing mid-scroll resumes at the right listing with no duplicate sightings; extractor fixture tests green; a deliberately broken selector trips the health guard and aborts the run.

**M4 — Email enrichment.** Domain job queue, undici fetcher, robots, sitemap, scored frontier, all extraction channels, the full junk-rule table, per-domain cache + TTL, JS fallback budget.
*Done when:* on a 200-domain labeled corpus, recall meets or beats the legacy crawler and **zero** telemetry-, image-, or hash-derived addresses survive; a domain shared by 12 businesses is crawled once and links to all 12; per-domain page/time/byte budgets are never exceeded; `maxDepth: null` terminates.

**M5 — Exporters.** Exporter interface, cursors, `views/`, CSV exporter, Sheets exporter with service-account auth + batched RAW writes + backoff, `export` commands.
*Done when:* 10k rows reach Sheets with zero quota errors; zips and phone numbers keep leading zeros; an immediate re-run exports zero rows; a mid-export network kill resumes without duplicates or gaps; CSV opens cleanly in Excel on Windows.

**M6 — Hardening & scale.** Full retry taxonomy wired, AIMD concurrency, run summary + metrics JSON, log rotation and pruning, `jobs` management commands, backup/vacuum, Dockerfile (Linux), Windows service/PM2 recipe, `import legacy`.
*Done when:* a 24-hour soak shows zero unhandled rejections, flat RSS, block rate under threshold, and auto-recovery from induced proxy death / DB lock / network partition; the legacy 438 rows and DONE flags import with honest per-`(city, category)` status.

**M7 — Automation #2 + API seam.** Yellow Pages implemented *without touching `src/core`* — the interface's proof of correctness. Then extract `core`/`db`/`config` behind `src/index.ts` and add a thin HTTP API over the same repositories (start/stop runs, job control, status stream), making the future dashboard a client and the CLI just another client.
*Done when:* Yellow Pages ships with zero diffs in `src/core`; the API can start a run, stream status, and retry a failed job; CLI and API produce identical DB effects.

---

## Verification

- **Per milestone:** `npm test` (vitest) green on the CI matrix; `gms doctor` green on macOS and a Windows VM/VPS.
- **M1 concurrency proof:** seed 10k fake jobs, run 8 workers, assert every job was leased exactly once and `SELECT COUNT(*) FROM jobs WHERE status='pending'` is 0.
- **M1/M3 crash proof:** start a run, `kill -9` mid-job, restart, assert the reaper reclaims the lease and the checkpoint resumes at the right listing index with no duplicate `business_sightings` rows.
- **M3 end-to-end:** `gms plan --cities Birmingham,Montgomery --categories Plumber` then `gms run --headful --max-jobs 3` and watch it live; then `gms status` and inspect `businesses` / `business_sightings` directly in SQLite.
- **M4 quality gate:** run enrichment over a labeled 200-domain fixture corpus and diff extracted emails against the labels; assert zero junk-class survivors.
- **M5 round-trip:** `gms export csv --full`, open in Excel on Windows, confirm leading zeros; `gms export sheets`, then re-run and confirm zero rows appended.
- **Legacy comparison:** re-scrape a handful of the original 438 rows' `(city, category)` pairs and compare field-by-field against the old output to confirm the new extraction is at least as complete.

---

## Risks

**Google blocking (highest).** Volume scraping of Maps draws rate limits. Mitigations: residential/ISP proxies with sticky sessions, resource blocking to cut requests per listing, jittered pacing, AIMD concurrency, per-identity job caps, and honest throughput expectations (1–2 weeks for a full sweep, not hours). Datacenter proxies will underperform badly here — budget for residential.

**Selector rot (near-certain, recurring).** Mitigated by the three-channel extractor, semantic `data-item-id`/ARIA selectors over hashed classes, CI fixture tests, live fill-rate guards that abort rather than write nulls, and artifact capture so a fix takes minutes.

**Legal / ToS — document in the README, do not bury.** Scraping Google Maps breaches Google's Terms of Service (a contract matter). More operationally binding is the outbound email: **CAN-SPAM** requires accurate headers, a valid physical postal address, and a working unsubscribe honored promptly — hence the `suppressions` table from day one. GDPR/ePrivacy makes scraping-and-emailing EU natural persons legally hazardous. *(Since November 2026 a French campaign exists by deliberate choice: `campaigns/gobadiz` sets out the B2B prospecting rules it follows — opt-out in every message, the data's source in the first one, minimisation by activating areas only when the team is ready, and an opt-out list every export honours.)* Never scrape behind a login; respect `robots.txt` on business websites by default.

**Windows / VPS quirks** (verified specifics, not folklore). Always `node:path` and `fileURLToPath`, never string concatenation. Antivirus causes intermittent `EPERM` on rename — retry file writes. Normalize CSV line endings explicitly. Beyond that:

- **Add an explicit `process.on('SIGBREAK')` handler.** Playwright's launcher registers only `exit`, `SIGINT`, `SIGTERM`, and `SIGHUP`, so Ctrl+Break on Windows takes the default action and orphans the whole Chromium tree.
- **Layer the orphan cleanup** rather than trusting Playwright: `await browser.close()` in a `finally`, plus the SIGBREAK handler, plus a startup sweep that enumerates processes and kills only `chrome.exe` whose command line matches this run's `--user-data-dir` prefix. Never blanket-kill `chrome.exe`. A hard guarantee against `taskkill /F` of the Node process would need a Windows Job Object, which plain Node cannot create — accept the gap and sweep at startup.
- **Prefer the new headless Chromium over headful on the VPS.** It removes the desktop, occlusion, RDP, and Session-0 problems entirely. If headful is kept, document why, never run as a Windows service (Session 0 has no interactive desktop), use CDP `page.screenshot` rather than OS screen capture, and run `tscon <SessionID> /dest:console` before disconnecting RDP.
- **MAX_PATH is a filename-hygiene concern, not a Node one.** Node 22+ handles long paths itself, but git, 7-Zip, Explorer, and installers still break at 260 chars. Keep the working root shallow (e.g. `C:\gms\`) and hash or truncate filenames derived from Google Maps business names, which are long and frequently contain emoji or CJK.

**Disk growth.** The `pages` table is config-gated; artifacts prune by `retainDays`; `db vacuum` is in the CLI; `businesses.raw_json` can be disabled once extraction stabilizes.

---

## First files to write

The five that determine whether everything else composes:

1. `src/core/automation/types.ts` — the `Automation` / `Emission` / `AutomationContext` contract
2. `src/db/schema.ts` — Drizzle schema for the DDL above; drives repositories, migrations, and the Postgres port
3. `src/core/engine/orchestrator.ts` — leasing, heartbeat, reaper, the records+checkpoint single transaction, exporter fan-out
4. `src/config/schema.ts` — the zod config surface; doubles as the future API's validation layer
5. `src/automations/google-maps/extract/merge.ts` — three-channel merge, per-field provenance, health guard

Seed data comes from the existing `assests/Copy Google Map Email Scrapping Testing.xlsx` via `gms import cities|categories|legacy`.
