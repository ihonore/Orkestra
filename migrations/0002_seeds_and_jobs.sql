-- Seed data (cities, categories), run records, and the job queue.
--
-- All tables are STRICT: SQLite's default type affinity silently accepts a
-- string into an INTEGER column, and a queue whose `status` can quietly become
-- the number 0 is not a queue you can reason about.

-- ─── seeds ──────────────────────────────────────────────────────────────────

CREATE TABLE cities (
  id          INTEGER PRIMARY KEY,
  -- Stored zero-padded to 5. The source spreadsheet had lost the leading zero
  -- on 8 of them (San Juan PR arrived as '901'), which is exactly how a lookup
  -- against any other zip dataset starts failing.
  zip         TEXT    NOT NULL UNIQUE,
  city        TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  state_code  TEXT    NOT NULL,          -- postal abbreviation: 'AL', 'CA'
  county      TEXT,
  -- Combined 5-digit state+county FIPS, zero-padded. The source stored these as
  -- numbers, so 27 of 185 had lost their leading zero ('1073' -> '01073').
  county_fips TEXT,
  lat         REAL    NOT NULL,
  lng         REAL    NOT NULL,
  population  INTEGER,                   -- optional; feeds job priority
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Verbatim STATUS from the legacy sheet. Kept as provenance only: it was
  -- per-city, so it cannot express "Atlanta+Plumber done, Atlanta+Roofing not".
  legacy_status TEXT,
  source      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX cities_state_city_idx ON cities (state_code, city);
CREATE INDEX cities_active_idx     ON cities (active);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,   -- 'Garage door repair/Installation'
  slug        TEXT    NOT NULL UNIQUE,   -- 'garage-door-repair-installation'
  aliases     TEXT,                      -- JSON array of alternate search terms
  weight      REAL    NOT NULL DEFAULT 1.0,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Legacy STATUS was global across all cities, so it says nothing about any
  -- particular (city, category) pair. Provenance only.
  legacy_status TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX categories_active_idx ON categories (active);

-- ─── runs ───────────────────────────────────────────────────────────────────

CREATE TABLE runs (
  id            TEXT    PRIMARY KEY,     -- time-sortable ULID-style id
  automation_id TEXT    NOT NULL,
  config_hash   TEXT    NOT NULL,
  config_json   TEXT    NOT NULL,        -- secrets redacted before storing
  host          TEXT,
  pid           INTEGER,
  version       TEXT,
  status        TEXT    NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'aborted', 'failed')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  stats_json    TEXT
) STRICT;

CREATE INDEX runs_started_idx ON runs (started_at DESC);

-- ─── job queue ──────────────────────────────────────────────────────────────

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  automation_id TEXT    NOT NULL,
  -- Stable natural key for the unit of work, e.g. 'city:12|cat:7'. The UNIQUE
  -- constraint below is what makes `plan` idempotent and what collapses a
  -- fan-out of the same domain from many businesses into one crawl job.
  task_key      TEXT    NOT NULL,
  params_json   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'leased', 'done', 'failed', 'skipped', 'paused')),
  priority      INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  -- Backoff gate (epoch ms). A failed job returns to 'pending' with this set
  -- into the future, so retries are paced without a separate scheduler.
  scheduled_at  INTEGER NOT NULL DEFAULT 0,

  lease_owner      TEXT,
  lease_expires_at INTEGER,
  -- THE FENCING TOKEN. Incremented by BOTH the claim and the reaper.
  --
  -- Every write a worker makes about its job carries
  -- `WHERE lease_owner = ? AND lease_epoch = ?`. When the reaper decides a lease
  -- is dead and hands the job to someone else, it bumps this, so the original
  -- worker — which may merely have been paused, not dead — finds `changes = 0`
  -- and discards its results instead of writing them alongside the new owner's.
  --
  -- Without it the recovery mechanism itself reintroduces the duplicate-row
  -- disease this system exists to fix.
  lease_epoch      INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     INTEGER,

  last_error      TEXT,
  last_error_kind TEXT,
  result_count    INTEGER NOT NULL DEFAULT 0,

  first_run_id TEXT,
  last_run_id  TEXT,

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,

  UNIQUE (automation_id, task_key),

  -- A leased job must always have an owner and an expiry. Without both, the
  -- reaper's `lease_expires_at < now` can never match it and the job is stranded
  -- in 'leased' forever, invisible to claim, reap and retry alike. Making the
  -- state unrepresentable is cheaper than detecting it later.
  CHECK (status <> 'leased' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (attempts >= 0 AND max_attempts >= 1)
) STRICT;

-- The claim's subquery runs while holding the global write lock, so a full scan
-- here would serialize every worker in the system.
--
-- Partial (WHERE status='pending') so only claimable rows are indexed, which
-- keeps it small as completed jobs accumulate.
--
-- Column order matters more than it looks: it must match the claim's ORDER BY
-- (priority DESC, scheduled_at ASC, id ASC) exactly, so SQLite can walk the
-- index in order and stop at the first row. Ordering by scheduled_at first
-- instead forces "USE TEMP B-TREE FOR ORDER BY" — sorting every pending row on
-- every claim, while holding the write lock. Measured on a 15,725-job queue:
-- 493µs/claim sorted vs 2µs/claim ordered, a 246x difference.
CREATE INDEX jobs_claim_idx
  ON jobs (automation_id, priority DESC, scheduled_at, id)
  WHERE status = 'pending';

-- Drives the reaper's sweep for expired leases.
CREATE INDEX jobs_lease_idx
  ON jobs (lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX jobs_status_idx ON jobs (automation_id, status);

-- Mid-job resume point. Written in the SAME transaction as the records it
-- describes, so "records saved but checkpoint lost" cannot happen — that split
-- is precisely how the legacy system re-scraped businesses it already had.
CREATE TABLE job_checkpoints (
  job_id      INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  cursor_json TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
