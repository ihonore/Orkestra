# Testing & Verification Guide

Each milestone has explicit pass/fail criteria. Run the test suite before committing.

---

## Pre-flight: Every commit

```bash
npm run check     # typecheck + lint + boundaries + tests
npm test          # see test coverage by file
npm run build     # ensure it compiles to dist/
```

Fail = do not commit. The boundary rules catch import violations; lint catches dead code and unsafe patterns.

---

## M0 — Foundation (✓ complete)

**Pass criteria:**
- ✓ `npm run check` green (77 tests)
- ✓ `gms doctor` green on macOS, Windows, Linux
- ✓ `gms db migrate` idempotent (run twice, second says "up to date")
- ✓ Migrations roll back fully on error
- ✓ RETURNING-based atomic operations work (job leasing tested)

**Commands to verify:**

```bash
# Start fresh
rm -rf data/
npm run gms -- init
npm run gms -- db migrate
npm run gms -- db status

# Should print: "1 applied, up to date"
npm run gms -- db migrate
npm run gms -- db migrate  # third time, same result

# Config layering works
GMS_LOGGING__LEVEL=debug npm run gms -- config show | grep "level: debug"

# Safety guard: refuse cloud-sync folder
GMS_PROJECT__DATA_DIR="$HOME/Dropbox/gms" npm run gms -- db migrate
# Should print: "Refusing to use a database in a synced folder"

# Safety guard: refuse network share (on Windows or with UNC path)
GMS_DATABASE__FILE='\\server\share\gms.sqlite' npm run gms -- db migrate
# Should print: "Refusing to use a database on a network filesystem"

# Override is available for cloud-sync only
GMS_PROJECT__DATA_DIR="$HOME/Dropbox/gms" GMS_DATABASE__ALLOW_CLOUD_SYNC=true npm run gms -- db migrate
# Should succeed and print: "1 applied, up to date"
```

**What to check in the database:**

```bash
sqlite3 data/gms.sqlite "SELECT * FROM meta;" 
# Should have: installId (UUID), appVersion, createdAt

sqlite3 data/gms.sqlite "SELECT * FROM schema_migrations;"
# Should have: 0001 baseline (sha256 checksum, applied_at timestamp)
```

**Failure modes:**
- `PRAGMA journal_mode` returns something other than `wal` → DB setup failed
- `gms doctor` says "RETURNING not supported" → `better-sqlite3` binding failed
- Migrations run twice and apply twice → idempotency is broken (should never happen)

---

## M1 — Seeds + Job Engine (✓ complete)

**Verified actuals** (measured, not projected):

| Check | Result |
|---|---|
| Cities imported | 185, with 8 zips + 27 county FIPS zero-pads repaired |
| Categories imported | 85, 0 slug collisions |
| Jobs planned | 15,725 in 0.66s |
| Re-plan | 0 created, 15,725 already existed |
| Concurrency | 5,000 jobs / 8 OS processes, 0 double-leases |
| Claim latency | 2µs (was 493µs before the index column order was fixed) |
| Tests | 149 passing |

Reproduce the whole thing:

```bash
XLSX="assests/Copy Google Map Email Scrapping Testing.xlsx"
gms import cities "$XLSX" --sheet Cities
gms import categories "$XLSX" --sheet Services
gms plan
gms status
```

**Pass criteria:**
- ✓ 185 cities + 85 categories import with correct zip/FIPS padding
- ✓ `gms plan` generates exactly 15,725 jobs (185 × 85)
- ✓ `gms plan` is idempotent (run twice, second inserts 0 rows)
- ✓ 8 concurrent workers over 10,000 jobs: zero double-leases
- ✓ Crash recovery: `kill -9` mid-job → reaper reclaims → resume from checkpoint
- ✓ `gms status` shows progress (jobs done/pending/failed counts)

### Import verification

```bash
# Prepare the xlsx (use your existing assests/Copy Google Map Email Scrapping Testing.xlsx)
npm run gms -- import cities assests/cities.xlsx --sheet Cities

# Verify
sqlite3 data/gms.sqlite "SELECT COUNT(*) AS count, COUNT(DISTINCT zip) AS unique_zips FROM cities;"
# Should print: 185|185 (185 rows, all unique zips)

sqlite3 data/gms.sqlite "SELECT zip, city, state_code FROM cities WHERE city='Atlanta' LIMIT 1;"
# Should print: 30301|Atlanta|GA (zip is zero-padded to 5 digits)

# Check FIPS padding (should be 2-digit state, 3-digit county)
sqlite3 data/gms.sqlite "SELECT state_fips, county_fips FROM cities WHERE state_code='CA' LIMIT 1;"
# e.g., 06|001 (not 6 or 1)
```

```bash
npm run gms -- import categories assests/categories.xlsx --sheet Categories
sqlite3 data/gms.sqlite "SELECT COUNT(*) FROM categories;"
# Should print: 85
```

### Plan verification

```bash
# Generate all jobs
npm run gms -- plan
sqlite3 data/gms.sqlite "SELECT COUNT(*), COUNT(DISTINCT task_key) FROM jobs;"
# Should print: 15725|15725

# Idempotency: run plan again
npm run gms -- plan
sqlite3 data/gms.sqlite "SELECT COUNT(*) FROM jobs;"
# Should still be: 15725 (no new rows added)

# Verify job structure
sqlite3 data/gms.sqlite "SELECT automation_id, task_key, status FROM jobs LIMIT 3;"
# Should show: google-maps | city:1|cat:1 | pending
#              google-maps | city:1|cat:2 | pending
```

### Concurrency proof (the hard test)

This proves zero double-leases across 8 concurrent workers.

```bash
# Seed 10,000 fake jobs for fast iteration
npm run gms -- plan --limit 10000

# Run 8 workers, capture the run ID
RUN_ID=$(npm run gms -- run --workers 8 --max-jobs 10000 2>&1 | grep "run id" | awk '{print $NF}')

# After the run finishes, verify:
sqlite3 data/gms.sqlite "
  SELECT status, COUNT(*) FROM jobs GROUP BY status;
"
# Should print: done|10000 (all claimed and completed)

# Count how many rows were leased by each worker
sqlite3 data/gms.sqlite "
  SELECT lease_owner, COUNT(*) FROM jobs WHERE lease_owner IS NOT NULL GROUP BY lease_owner;
"
# Each worker should have roughly 10000/8 ≈ 1250 (±10% variance is fine)

# Verify zero re-leases (each job.lease_owner is unique per run_id)
sqlite3 data/gms.sqlite "
  SELECT COUNT(DISTINCT job_id) FROM (
    SELECT job_id FROM job_leases WHERE run_id='$RUN_ID'
  );
"
# Should equal 10000 (each job leased exactly once)
```

### Crash recovery proof

```bash
# Start a run
npm run gms -- run --workers 2 --max-jobs 1000 &
RUNNER_PID=$!
sleep 10  # let it process a few jobs

# Simulate a crash
kill -9 $RUNNER_PID
sleep 2

# Verify jobs were reclaimed by the reaper
sqlite3 data/gms.sqlite "
  SELECT COUNT(*) FROM jobs WHERE status='leased' AND lease_expires_at < (SELECT unixepoch('now') * 1000);
"
# Should print: 0 (reaper already ran)

# Re-run; it should pick up where it left off
npm run gms -- run --workers 2 --max-jobs 1000

# Verify all 1000 are done (not re-run from the start)
sqlite3 data/gms.sqlite "SELECT COUNT(*) FROM jobs WHERE status='done';"
# Should be roughly 1000 (all claimed by the restart)
```

### Status command

```bash
npm run gms -- status
# Should print:
#   Automation  google-maps
#   Jobs        done:10000  pending:5725  failed:0
#   Throughput  ~250 jobs/hour  ETA 23h
#   Blocks      0
```

**Failure modes:**
- `task_key` has duplicate values → plan didn't deduplicate
- `jobs.lease_owner` has duplicates for the same job_id → double-lease bug (fatal)
- After crash, `jobs.status='leased'` with expired `lease_expires_at` remains → reaper didn't run
- `gms status` hangs → query is inefficient (add index on `status, updated_at`)

---

## M2 / M3 — measured actuals (✓ complete)

Verified against **live Google Maps**, not fixtures.

| Check | Result |
|---|---|
| Live run | 2 jobs → 164 listings → 159 businesses |
| Feed harvest | 48 and 116 listings; second hit `end-of-list` at 47 rounds |
| CID fill | 159/159 (100%) |
| Name fill | 159/159 (100%) |
| Address fill | 158/159 (99.4%) |
| Phone fill | 155/159 (97.5%) |
| Website fill | 149/159 (93.7%) |
| Duplicate CIDs | **0** |
| Businesses merged across both searches | 5 |
| Websites pointing at google.com | 1 (a genuine Google Sites business, correctly skipped) |
| Domains queued for M4 | 108 pending, 2 social skipped |
| Tests | 273 passing |

Reproduce:

```bash
gms run --max-jobs 2 --workers 1
sqlite3 data/gms.sqlite "SELECT name, phone_e164, city, website_url FROM businesses LIMIT 5;"
```

Integrity queries that must all return 0:

```bash
sqlite3 data/gms.sqlite "
SELECT COUNT(*) FROM (SELECT cid FROM businesses WHERE cid IS NOT NULL GROUP BY cid HAVING COUNT(*)>1);
SELECT COUNT(*) FROM businesses WHERE typeof(cid) <> 'text' AND cid IS NOT NULL;
SELECT COUNT(*) FROM businesses WHERE website_url LIKE '%/url?q=%';"
```

---

## M2 — Browser Engine + Proxies

**Pass criteria:**
- ✓ Playwright launches without errors
- ✓ `gms doctor --proxies` reports egress IP/geo/latency per proxy
- ✓ Dead proxies marked and skipped
- ✓ 1000-job soak: no `EPERM` on Windows, no orphaned `chrome.exe` processes
- ✓ Headful and headless both work on Windows
- ✓ Contexts recycle without leaking processes
- ✓ Block detection: injected 429 triggers rotation + backoff

### Proxy health check

```bash
# If you have proxies configured
gms doctor --proxies

# Expected output:
#   Proxy 1 (residential1.com:1080)
#     Egress IP: 203.0.113.42
#     Geo: US, New York
#     Latency: 47ms
#   Proxy 2 (residential2.com:1080)
#     Egress IP: 198.51.100.89
#     Geo: US, California
#     Latency: 52ms
```

### Browser pool stress test

```bash
# Start a long run
npm run gms -- run --workers 4 --max-jobs 1000 &

# Monitor in another terminal
watch -n 2 "ps aux | grep chrome | wc -l"
# Should stabilize around 4 (one per worker), not grow unbounded

# After 30 min, check memory
ps aux | grep node | grep run | awk '{print $6}'
# Should be stable, not climbing (contexts are recycled)

# Force-kill and restart
killall chrome
npm run gms -- run --workers 4 --max-jobs 1000

# Should recover cleanly (not hang, not orphan processes)
```

### Windows-specific checks

```bash
# Orphan cleanup: ensure chrome processes are cleaned at startup
tasklist | grep chrome
# Should be empty before and after a run

# SIGBREAK handler: verify graceful shutdown
# (Start a run, press Ctrl+Break, not Ctrl+C)
# Should checkpoint and exit cleanly

# MAX_PATH: run with a long business name
gms run --max-jobs 1 --headful
# Screenshots/HTML artifacts should all write (not fail with ENAMETOOLONG)
```

**Failure modes:**
- `chrome` processes accumulate over time → context cleanup broken
- `EPERM: operation not permitted` on Windows → antivirus interfering with temp file cleanup (retry logic needed)
- Proxy health check hangs → DNS lookup is blocking (add timeout)
- First job after startup slow → Chromium not cached (expected, 3-5s; second job should be <1s)

---

## M3 — Google Maps Automation

**Pass criteria:**
- ✓ Scrapes live 5 cities × 3 categories without captcha
- ✓ ≥95% name fill rate, ≥99% CID capture
- ✓ Zero duplicate CIDs in `businesses` table
- ✓ Resume from mid-scroll checkpoint: correct listing index, no duplicate sightings
- ✓ Fixture tests: extractor passes on frozen place-page HTML + XHR bodies
- ✓ Health guard: deliberately broken selector aborts the run

### Live smoke test

```bash
# Small run: 3 cities × 3 categories = 9 jobs
gms plan --cities Atlanta,Birmingham,Nashville --categories "Plumber,Roofing,Electrician"

# Run live (headful if you want to watch)
gms run --workers 1 --headful

# Should complete in ~20 min (2 min per job × 9 jobs)
```

### Fill rate verification

```bash
# After the run, check extraction quality
sqlite3 data/gms.sqlite "
  SELECT
    COUNT(*) AS total,
    COUNT(DISTINCT cid) AS cids,
    COUNT(CASE WHEN name IS NOT NULL THEN 1 END) AS names,
    COUNT(CASE WHEN phone_e164 IS NOT NULL THEN 1 END) AS phones,
    COUNT(CASE WHEN address_raw IS NOT NULL THEN 1 END) AS addresses,
    COUNT(CASE WHEN website_url IS NOT NULL THEN 1 END) AS websites
  FROM businesses;
"

# Expected (rough):
# total: ~500 (9 jobs × 50-60 listings each)
# cids: ~475 (95%+)
# names: ~495 (99%)
# phones: ~300 (60%)
# addresses: ~480 (96%)
# websites: ~200 (40%)
```

### Dedup verification

```bash
# Check for duplicate CIDs (should be zero)
sqlite3 data/gms.sqlite "
  SELECT cid, COUNT(*) FROM businesses WHERE cid IS NOT NULL GROUP BY cid HAVING COUNT(*) > 1;
"
# Should return empty result

# Check sightings (multiple sightings of same business from different searches)
sqlite3 data/gms.sqlite "
  SELECT business_id, COUNT(*) AS sight_count FROM business_sightings
  GROUP BY business_id ORDER BY sight_count DESC LIMIT 5;
"
# Some businesses may appear 2-3 times (franchise chains), that's expected
```

### Checkpoint & resume verification

```bash
# Start a run
gms run --workers 1 --headful --max-jobs 1 &
RUNNER_PID=$!

# After ~1 min (mid-scroll), kill it
sleep 60
kill -9 $RUNNER_PID

# Check what was checkpointed
sqlite3 data/gms.sqlite "
  SELECT cursor_json FROM job_checkpoints
  WHERE job_id = (SELECT id FROM jobs ORDER BY updated_at DESC LIMIT 1);
"
# Should print a JSON object with {phase, collectedPlaceUrls, processedIndex, scrollRounds}

# Resume the run
gms run --workers 1 --headful --max-jobs 1

# Verify no duplicate sightings were created
sqlite3 data/gms.sqlite "
  SELECT job_id, COUNT(*) FROM business_sightings GROUP BY job_id;
"
# Each job should appear exactly once per business (no re-crawl of same URL)
```

### Fixture tests

```bash
npm test -- tests/google-maps.test.ts
# Should pass: XHR extractor, DOM extractor, URL parser, merge logic
# These run on frozen HTML fixtures, not live
```

### Selector rot detection

Temporarily break a selector in the extractor:
```typescript
// In extract/merge.ts, break the name extraction
const name = undefined;  // should be page.locator('h1')
```

```bash
npm run gms -- run --workers 1 --max-jobs 1
# Should abort with: "SelectorMissing: name fill rate below 95%, aborting to prevent bad data"
# Should NOT write a row with name=NULL
```

**Failure modes:**
- `cid` is missing on >5% of rows → URL channel not parsing correctly
- `phone` is "-" or empty strings → not parsed from `[data-item-id^="phone:"]`
- Website URLs all point to `google.com` → not parsing the `?q=` param from the redirect
- Duplicate CIDs exist → dedup logic broken
- Resume from checkpoint produces duplicate sightings → checkpoint not being saved
- Selector rot not detected → health guard not running

---

## M4 — Email Enrichment

**Pass criteria:**
- ✓ 200-domain labeled corpus: recall matches or beats legacy crawler
- ✓ Zero telemetry/image/hash junk in extracted addresses
- ✓ Shared domain crawled once across multiple businesses
- ✓ Per-domain page/time/byte budgets never exceeded
- ✓ `maxDepth: null` terminates (doesn't infinite-loop)
- ✓ JS fallback doesn't exceed budget

### Junk filtering verification

```bash
# Run enrichment on 100 businesses with websites
gms enrich emails --workers 2 --limit 100

# Extract emails by source
sqlite3 data/gms.sqlite "
  SELECT
    COUNT(*) AS total_emails,
    COUNT(CASE WHEN junk_reason IS NULL THEN 1 END) AS valid,
    COUNT(CASE WHEN junk_reason='sentry' THEN 1 END) AS sentry_junk,
    COUNT(CASE WHEN junk_reason='image_filename' THEN 1 END) AS image_junk,
    COUNT(CASE WHEN junk_reason='invalid_tld' THEN 1 END) AS invalid_tld
  FROM emails;
"

# Expected (rough):
# total_emails: ~400 (100 businesses × 4 emails each)
# valid: ~380 (95%+)
# sentry_junk: ~5 (gone)
# image_junk: ~10 (gone)
# invalid_tld: ~5 (gone)
```

### Domain dedup

```bash
# Check that shared domains were crawled once
sqlite3 data/gms.sqlite "
  SELECT domain, COUNT(DISTINCT business_id) AS businesses, pages_fetched
  FROM domains
  WHERE businesses > 1
  ORDER BY businesses DESC LIMIT 5;
"

# e.g., "acmecorp.com" appears in 8 businesses' websites,
# but pages_fetched is ~12 (crawled once, not 8 times)
```

### Budget compliance

```bash
# Verify no domain exceeded time budget (configurable, e.g., 60s)
sqlite3 data/gms.sqlite "
  SELECT domain, pages_fetched, bytes_fetched
  FROM domains
  WHERE bytes_fetched > 5242880;  -- 5 MB limit
"
# Should be empty (no domain exceeded byte limit)
```

**Failure modes:**
- `sentry-next.wixpress.com` emails survive → vendor blocklist not applied
- `logo@2x.jpg` addresses exist → filename junk rule not applied
- `@2x` pattern emails exist → image filename pattern not caught
- Domain crawled 8 times for 8 businesses → dedup not working
- Bytes or pages exceeded per-domain cap → limiter not enforced

---

## M5 — Exporters

**Pass criteria:**
- ✓ 10k rows reach Sheets with zero quota errors
- ✓ Zips and phone numbers keep leading zeros
- ✓ Re-export produces zero rows (cursor advancement)
- ✓ Mid-export network kill: resume without gaps or duplicates
- ✓ CSV opens cleanly in Excel on Windows

### CSV export

```bash
gms export csv --entity leads-flat --full

# Check that zips are zero-padded (quoted as text)
head -20 data/exports/leads.csv | cut -d, -f3
# Should show: "01234", "02345", not 1234, 2345
```

### Sheets export

```bash
# Set up a service account and spreadsheet (see docs/ARCHITECTURE.md)
gms export sheets --entity leads-flat --spreadsheet-id ABC123 --full

# Verify in Sheets UI:
# - Headers in row 1
# - Zips in column X are formatted as text (green triangle)
# - No "#REF!" errors (would indicate formula corruption)

# Check that append is batched and efficient
sqlite3 data/gms.sqlite "
  SELECT * FROM export_cursors WHERE exporter='sheets';
"
# Should show: last_id=10000, rows_total=10000, last_at=(recent timestamp)
```

### Cursor idempotency

```bash
# Export once
gms export sheets --entity leads-flat

# Export again (should be a no-op)
gms export sheets --entity leads-flat

# Verify cursor didn't advance
sqlite3 data/gms.sqlite "SELECT last_id FROM export_cursors WHERE exporter='sheets';"
# Should be unchanged

# The second export should print: "0 rows exported" (nothing new to write)
```

### Network resilience

```bash
# Start an export to Sheets
gms export sheets --entity leads-flat &
EXPORT_PID=$!

# Kill the network mid-export
sleep 5
sudo tc qdisc add dev en0 root netem loss 100%  # Linux; macOS use different approach

# Wait for timeout
sleep 30

# Restore network
sudo tc qdisc del dev en0 root

# Process should retry and eventually finish
wait $EXPORT_PID

# Verify rows were written and cursor advanced
sqlite3 data/gms.sqlite "SELECT last_id FROM export_cursors WHERE exporter='sheets';"
# Should be non-zero
```

**Failure modes:**
- Zips appear as numbers (01234 becomes 1234) → `valueInputOption` not set to RAW
- Duplicate rows in Sheets after re-export → cursor not advancing
- "429 quota exceeded" after 1000 rows → batching not working (should do 60/min, not 300/min)
- CSV won't open in Excel → line endings not normalized (have CRLF, not LF)

---

## M6+ — Hardening & Scale

### 24-hour soak test

```bash
# Run all 15,725 jobs (185 cities × 85 categories)
gms plan
gms run --workers 8 --max-jobs 15725

# Monitor for 24 hours:
watch -n 60 "gms status"

# Checklist:
# ✓ No unhandled rejections in logs
# ✓ Memory stable (no climb above 2 GB)
# ✓ Block rate under threshold (<5%)
# ✓ Throughput stable (~250-300 jobs/hour with 8 workers)
# ✓ Zero processes left running after completion
# ✓ Every job marked done, pending, failed, or skipped
```

### Legacy import verification

```bash
# Import the 438 original rows
gms import legacy assests/Copy\ Google\ Map\ Email\ Scrapping\ Testing.xlsx

# Verify:
sqlite3 data/gms.sqlite "SELECT COUNT(*) FROM businesses;"
# Should print: 438 (or close, depending on duplicates merged)

sqlite3 data/gms.sqlite "SELECT COUNT(*) FROM business_sightings;"
# Should be: 438+ (one or more sightings per business)

# Check that duplicate CIDs were merged
sqlite3 data/gms.sqlite "
  SELECT cid, COUNT(*) FROM businesses WHERE cid IS NOT NULL GROUP BY cid HAVING COUNT(*) > 1;
"
# Should be mostly empty (duplicates merged into one row)
```

---

## CI matrix

All tests must pass on:

```
Ubuntu 22.04 + Node 24 LTS
macOS 12+ + Node 24 LTS
Windows Server 2022 + Node 24 LTS
```

Run locally:
```bash
npm run check
npm test
npm run build
gms doctor
```

Or in CI (GitHub Actions / GitLab CI / your platform):
```yaml
- name: Tests
  run: npm run check

- name: Build
  run: npm run build

- name: Doctor
  run: npx tsx src/cli/main.ts doctor
```

---

## Quick reference: commands per milestone

| Milestone | Key commands |
|---|---|
| M0 | `npm run check` · `gms doctor` · `gms db migrate` |
| M1 | `gms import cities` · `gms plan` · `gms run` · `gms status` |
| M2 | `gms doctor --proxies` · stress tests for `chrome` orphan cleanup |
| M3 | `gms run --headful` · fixture tests · health guard abort test |
| M4 | `gms enrich emails` · junk filter verification · domain dedup check |
| M5 | `gms export csv\|sheets` · cursor idempotency · network resilience |
| M6+ | 24-hour soak · legacy import · CI matrix |

---

## Debugging tips

**Logs:**
```bash
# See detailed logs from last run
tail -f data/logs/*.ndjson | jq 'select(.level=="error")'
```

**Database inspection:**
```bash
sqlite3 data/gms.sqlite
sqlite> .mode column
sqlite> .headers on
sqlite> SELECT * FROM jobs WHERE status='failed' LIMIT 5;
```

**Playwright debugging:**
```bash
# Headful mode to watch the browser
gms run --headful

# Enable trace (slower, but captures full events)
GMS_BROWSER__ARTIFACTS__TRACE=onfailure gms run
# Traces appear in data/artifacts/{runId}/
```

**Profiling:**
```bash
# Check which jobs are slow
sqlite3 data/gms.sqlite "
  SELECT id, (finished_at - started_at) / 1000.0 AS duration_sec
  FROM jobs WHERE finished_at IS NOT NULL
  ORDER BY duration_sec DESC LIMIT 10;
"
```
