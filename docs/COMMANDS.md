# Command reference

Every `gms` command, what it does, and what it does that you would not guess.

The CLI itself is always the last word: `gms --help` lists the commands and
`gms help <command>` (e.g. `gms help export`) prints the flags for one of them.
This file adds the part the help text has no room for — what each command
touches, whether it is safe to re-run, and where it will surprise you.

---

## The short path

Seven commands, in the order you use them. Everything else is inspection or
maintenance.

```bash
gms init                                    # 1. create gms.config.yaml and data/
gms db migrate                              # 2. create the database
gms import cities  leads.xlsx --sheet Cities
gms import categories leads.xlsx --sheet Services   # 3. load the seed lists
gms plan                                    # 4. build the queue of searches
gms run                                     # 5. scrape Google Maps
gms enrich emails                           # 6. find addresses on their websites
gms export sheets                           # 7. publish to the team's sheet
```

Steps 4–7 are all safe to re-run. `plan` skips searches it already created,
`run` resumes where it stopped, `enrich` skips sites crawled in the last 90
days, and the exports only send what is new.

Prefer clicking to typing? `gms ui --control` puts all of the above behind
buttons in a local web page.

---

## Global options

These belong to `gms` itself, so they work with any command and may go **before
or after** the subcommand — `gms -c alt.yaml status` and `gms status -c alt.yaml`
are the same.

| Flag | Meaning |
| --- | --- |
| `-c, --config <path>` | Config file to read. Default: look in the **current directory** for `gms.config.yaml`, then `.yml`, then `.json` |
| `--data-dir <path>` | Override `project.dataDir` for this one invocation |
| `--log-level <level>` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `-v, --version` | Print the version and exit — including after a subcommand, so `gms run -v` prints the version instead of running |
| `-h, --help` | Usage for the command it follows |

Three things about config discovery that cost real time when you don't know them:

- **There is no upward search.** The config is looked for in the directory your
  shell is in, not in any parent. Run `gms status` from `docs/` and it finds no
  config, silently falls back to built-in defaults, and reports on an empty
  `docs/data/gms.sqlite` it just created. `cd` to the project root first.
- **`-c` disables the local overlay.** With auto-discovery, `gms.config.local.yaml`
  is layered on top of `gms.config.yaml`. Naming a file explicitly loads that one
  file only, so the same machine can give two different answers.
- **On `gms ui`, `-c` is not `--control`.** The help text says `-c, --control`,
  but the global `-c, --config` wins: `gms ui -c` fails with *"option '-c,
  --config <path>' argument missing"*, and `gms ui -c mine.yaml` starts a
  **view-only** dashboard. Always type `--control` in full.

Almost every command takes `--json` for machine-readable output. The exceptions
are `gms import sheets`, `gms jobs retry`, `gms db check`, `gms db vacuum` and
`gms db backup`, which reject it as an unknown option.

---

## Setup

### `gms init`

Writes the starter `gms.config.yaml` and creates `data/`, `data/logs/`,
`data/artifacts/` and `data/exports/`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-f, --force` | off | Overwrite an existing config with the stock template |

- Writes into the directory you are standing in. `-c` and `--data-dir` are
  accepted here but **ignored** — `cd` to the folder you want set up first.
- Creates `.gitignore` if absent (`data/`, `gms.config.local.yaml`, `.env`); if
  one exists it only appends the missing lines.
- Does **not** create the database. Run `gms db migrate` next.
- The only command that works when the config is corrupt, because it never
  reads it.
- `--force` restores the stock template verbatim — your settings *and* your
  comments are gone, with no backup and no prompt.
- The folder names it creates are hardcoded to `data/…`. If you set
  `project.dataDir: ./scrapes`, init still makes an empty `./data`, and the
  `.gitignore` line it wrote (`data/`) no longer covers your real database — one
  careless `git add .` commits your lead list.

### `gms doctor`

Checks what a long run depends on before you start one.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--proxies` | off | Probe every proxy, report egress IP, geo and latency |
| `--browser` | off | Launch Chromium to prove it works |
| `--sheets` | off | Verify Google Sheets credentials and access |
| `--all` | off | All of the above |
| `--json` | off | Machine-readable report |

- **A bare `gms doctor` does not test the browser, the proxies or Sheets.**
  Those three are opt-in because each costs seconds. Use `--all` before a real
  run.
- Not read-only: it creates the data directory, writes and deletes a probe file
  to prove the folder is writable, opens (and therefore creates) the database,
  and creates `schema_migrations`. A first `doctor` on a clean machine leaves an
  empty database behind and reports migrations as pending.
- Refuses a database on a network share (UNC, `/net`, `/mnt/nfs`) as a hard
  failure — SQLite's write-ahead log cannot work there. Warns on OneDrive,
  Dropbox and iCloud folders, where sync agents copy the file mid-transaction.
- **Warnings do not fail it.** "6 migrations pending", "proxy.mode is none" and
  "Sheets not configured" all print yellow and still exit 0, so it is a poor
  deployment gate on its own. Exit code is 1 only if a check outright *fails*.
- `--sheets` can **modify your spreadsheet**: with `createIfMissing` on (the
  default) it creates the `Leads` tab and writes its header row.

### `gms config show`

Prints the settings actually in force after stacking defaults → `gms.config.yaml`
→ `gms.config.local.yaml` → `GMS_*` environment variables → flags.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--resolved` | off | Also print resolved paths, the layers that contributed, and a config fingerprint |
| `--json` | off | JSON instead of YAML |

- Completely read-only — no database, no files, no network. Safe mid-scrape.
- `--resolved` is the fastest way to answer "which database is this actually
  using?" when a command seems to be looking at the wrong data.
- Passwords are replaced with `[redacted]`, so the output is safe to paste into
  a support thread.
- A misspelled key in a **top-level** section (`runtime.worker`) is rejected
  outright and breaks every command until you fix it. Typos inside nested
  sub-objects (`runtime.adaptiveConcurrency`, `browser.artifacts`,
  `exporters.csv`, `enrichment.websiteEmails.validation`, …) are silently
  dropped instead — the setting simply never applies.

---

## Seed data

### `gms import sheets <file>`

Lists the tab names inside an `.xlsx`, so you know what to pass to `--sheet`.

- Read-only; opens no database and reads no config.
- The listed order *is* the numbering: the third tab is `--sheet 3`.
- `.xlsx` only. On a `.csv` it fails with the library's raw wording,
  *"Doesn't look like an `.xlsx` file"*.
- No `--json`.

### `gms import cities <file>` · `gms import categories <file>`

Load the seed lists that `gms plan` pairs up.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-s, --sheet <name>` | first tab | Tab name, or 1-based position |
| `--dry-run` | off | Parse and report without writing |
| `--json` | off | Machine-readable output |

- **`--sheet` matters more than it looks.** Without it you get the *first* tab,
  which on the supplied workbook is scraped results, not the city list — so a
  bare `gms import cities book.xlsx` fails with "missing required column(s):
  ZipCode".
- Cities need `ZipCode`, `City`, `Latitude`, `Longitude`. Common spellings are
  accepted (`zip`, `postal code`, `lat`, `lng`, `lon`) and matching ignores case
  and spacing.
- Repairs leading zeros Excel destroyed: ZIP `901` → `00901`, county FIPS `1073`
  → `01073`, and reports every repair.
- Bad rows are skipped and listed with the row number and reason, rather than
  failing the whole file.
- Matched on ZIP (cities) and slug (categories), so re-importing updates in
  place — the internal row id is preserved and jobs already planned stay
  attached. Re-running reports "inserted 0 / updated N".
- One transaction: Ctrl-C leaves the database exactly as it was.
- **Rows you delete from the spreadsheet are not deleted here.** Import only adds
  and updates; retire a city by setting it inactive.
- Re-importing overwrites with blanks too — a column you cleared in Excel clears
  in the database.
- `--sheet` is silently ignored for `.csv` files, and a numeric `--sheet` is
  always read as a position, so a tab literally named `2` cannot be selected.

---

## Building and running the queue

### `gms plan`

Pairs every selected city with every selected category and writes one job per
pair. 185 cities × 85 categories = 15,725 jobs.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a, --automation <id>` | `google-maps` | Which automation the jobs belong to |
| `--cities <list>` | every active city | Comma-separated names, ZIPs **or** state codes |
| `--categories <list>` | every active category | Comma-separated names or slugs |
| `--limit <n>` | no cap | Keep only the top-priority pairs |
| `--dry-run` | off | Report what would be created, write nothing |
| `--json` | off | Machine-readable output |

- Writes only to the `jobs` table. No browser, no network — a full 15,725-job
  plan takes about a second.
- Safe to re-run: each job's key is built from the city and category ids, so
  re-planning after importing more seeds adds only the new combinations.
- Priority is computed at plan time from city population (compressed, so the
  largest city doesn't dwarf everything) plus the category weight. That ordering
  is what puts your best leads in the first 48 hours.
- One transaction — Ctrl-C gives you all the jobs or none.
- **`--limit` caps the total, not the new ones.** `--limit 500` twice gives you
  500 jobs, not 1,000: the second run re-selects the same top-priority pairs and
  finds them already present.
- **Selectors are whole-value matches**, not searches. `Birmingham` works,
  `Birming` matches nothing and aborts. And `--cities` matches name *or* ZIP *or*
  state, so `--cities AL` quietly means every active Alabama city.
- A typo in `-a` is not an error — it creates a second, separate queue under that
  name that `gms run` will never pick up.

```bash
gms plan --dry-run                                  # how many jobs would this be?
gms plan --cities Birmingham,Montgomery --categories Plumber
gms plan --cities AL --limit 500                    # top 500 Alabama jobs
```

### `gms run`

Works through the queue: opens Chromium, walks the Maps results for each
search, saves what it finds.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a, --automation <id>` | `google-maps` | Which queue to work |
| `-w, --workers <n>` | `runtime.workers` (4) | Concurrent browser workers |
| `-n, --max-jobs <n>` | no limit | Stop after this many searches |
| `--headful` | off | Show the browser window |
| `--json` | off | Machine-readable summary |

- Only runs jobs `gms plan` already created. An empty queue exits 0 with
  `stopped: queue-empty`.
- Each job's businesses **and** its resume point commit in one transaction, so a
  crash can never save results while losing the resume point. Restarting picks
  the job up mid-scroll rather than re-scraping it.
- Existing businesses are matched and updated, not duplicated. Every result also
  writes a *sighting* row recording which search found it, and a domain row for
  every website — that domain queue is what `gms enrich emails` reads.
- Failures don't stop the run. A blocked job is requeued with growing backoff
  and its proxy identity is benched; other failures are recorded with the error,
  a screenshot and the page HTML under `data/artifacts/<runId>/<jobId>/`.
- A job abandoned by a crash keeps its claim until the lease expires
  (`runtime.jobLeaseSeconds`, 300s); a reaper returns it to pending, at startup
  and every `runtime.reaperIntervalSeconds`.
- **`--workers` is a starting point, not a ceiling.** Adaptive concurrency clamps
  the live count to `runtime.adaptiveConcurrency.min..max` (1–8 by default), so
  `--workers 20` really starts 8.
- **`--max-jobs` counts searches started**, including ones that fail or come back
  blocked, and several workers can overshoot it by one or two.
- **Each search stops at 120 listings**, hardcoded. A dense city + category is
  silently truncated.
- **It exits 0 even if every job failed.** Judge by "jobs failed" in the summary
  or `gms jobs list --status failed`, never by the exit code.
- Ctrl-C stops taking new work and closes the browsers; a second Ctrl-C exits
  immediately with code 130. See *Known rough edges* for what in-flight jobs
  actually get.

```bash
gms run                          # work the whole queue
gms run --max-jobs 3 --headful   # watch three searches happen
gms run --workers 2              # gentler on a small VPS
```

### `gms enrich emails`

Visits the websites `gms run` collected and looks for contact addresses.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-w, --workers <n>` | `runtime.httpWorkers` (16) | Concurrent HTTP workers |
| `-n, --max-domains <n>` | no limit | Stop after this many sites |
| `--json` | off | Machine-readable summary |

- No browser — plain HTTP fetches, which is why 16 at once is the default while
  `gms run` uses 4.
- Works from the domain queue, so a business with no website is never visited
  and social-media links are excluded up front.
- Per site: the landing page plus links one level deep (the contact/about
  pages), bounded by `maxPages` (8), `maxTimePerDomainMs` (60s) and
  `maxBytesPerDomain` (5 MB).
- Crawled once per domain globally, so a franchise's shared site is visited once
  no matter how many businesses point at it.
- Honours `robots.txt` by default. A site's own `Crawl-delay` replaces the normal
  250–900 ms politeness pause when it is longer — the two are not added.
- Government (`.gov`, `.mil`) and education (`.edu`) addresses are dropped, as
  configured — those directories were the largest junk source in the legacy data.
- Everything found for one site commits in one transaction.
- **Re-running straight after a pass reports "domains crawled: 0"** — every site
  is on the 90-day `recrawlAfterDays` cooldown. Changing the extraction rules
  does not reset it.
- `--max-domains` counts sites *taken off the queue*, including ones instantly
  skipped, so a cap of 100 can fetch fewer than 100.
- `--workers` bypasses the config's safety ceiling: `--workers 1000` really
  starts 1000.
- A page offering more than 5 usable addresses keeps only the first 5 and is
  flagged directory-like, so a genuine 8-person team page loses 3.
- **Ctrl-C strands work here.** See *Known rough edges*.

---

## Watching progress

### `gms status`

How far the run has got, and roughly how long the rest will take.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a, --automation <id>` | all | Restrict the counts to one automation |
| `--by <grouping>` | off | Per-group breakdown: `city`, `category` or `state` |
| `--incomplete` | off | With `--by`, hide groups with nothing left |
| `-n, --limit <n>` | 1000 | With `--by`, maximum groups to show |
| `--json` | off | Machine-readable output |

- Read-only for your data, and safe to run while a scrape is in progress —
  SQLite readers don't block the writer.
- The ETA uses only jobs finished in the **last 60 minutes**, so cold early jobs
  and yesterday's numbers don't skew it. At the very start of a run there is no
  throughput block at all; that's expected.
- Statuses with a count of zero are hidden, except `pending` and `done` which
  always print.
- With no jobs at all it stops and points you at `gms plan`.
- `--incomplete` and `-n` are silently ignored unless `--by` is present.
- `--by` quietly restricts to `google-maps`, while plain `gms status` totals
  every automation.

### `gms jobs list`

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a, --automation <id>` | all | Restrict to one automation |
| `-s, --status <status>` | all | `pending`, `leased`, `done`, `failed`, `skipped`, `paused` |
| `--error-kind <kind>` | all | e.g. `lease_expired`, `blocked` |
| `-n, --limit <n>` | 50 | Maximum rows |
| `--json` | off | Machine-readable output |

Read-only. `gms jobs list --status failed --error-kind blocked` is the fastest
way to tell "Google is rate-limiting me" from "this selector broke".

### `gms jobs retry [ids...]`

Puts failed or paused searches back in the queue.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-a, --automation <id>` | all | Restrict to one automation |
| `-s, --status <status>` | `failed` and `paused` | Retry jobs in this status instead |

- **This one changes your data.** Per job it resets status to pending, attempts
  to 0, clears the last error and the finish time, and **deletes the saved resume
  point** — so the search restarts from the beginning.
- It bumps the job's ownership counter, so if a named job happens to be running,
  that worker is fenced out and its results discarded rather than landing on top
  of your retry.
- One transaction; leads already collected are never deleted.
- **With no arguments it hits every automation**, not just `google-maps`.
- **Naming ids overrides the safety net**: `gms jobs retry 1` will re-queue a job
  whose status is `done`, with no confirmation.
- A non-numeric id fails silently — `gms jobs retry abc` prints "No jobs matched"
  and exits 0.
- Retried jobs go to the **back** of the queue: they are stamped with the current
  time, and at equal priority the oldest scheduled job wins.
- Resetting attempts to 0 is the point and also the risk — a job that failed
  three times for a permanent reason will now fail three more.
- No `--json`.

### `gms ui`

A local web page showing progress, leads, failures and exports — and, with
`--control`, buttons that run the commands for you.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | 4600 | Port to listen on |
| `--no-open` | off | Don't open a browser window |
| `--control` | off | Let the page start scrapes, imports and exports, and edit settings |
| `--allow-config-write` | off | Edit settings only, without task controls |

- Occupies the terminal until Ctrl-C. The first four lines tell you the URL, the
  exact database file, and whether controls and settings are enabled — read
  those two words to confirm which mode you got.
- **Binds to 127.0.0.1 only, and has no password.** That is the trade: the page
  shows names, phone numbers and addresses and can edit settings, so it is never
  reachable from another machine. Do not put it behind a public proxy.
- Reads open the database read-only and close immediately, so leaving it open for
  days won't block a running scrape.
- Buttons launch real `gms` commands as separate processes from a fixed
  allow-list with typed parameters — never a free-text command line — so a crash
  in the scraper can't take the dashboard down.
- Typed values are clamped, not rejected: browser workers 1–32, email workers
  1–64, max jobs 1–100,000. Asking for 500 workers silently gives 32.
- One task of each kind at a time; a second Scrape returns HTTP 409.
- **Type `--control` in full** — `-c` is the global `--config`.
- Settings you save don't appear until you restart `gms ui`, because the server
  read its configuration once at startup. Tasks started afterwards do use the new
  values.
- If you started it with an explicit `--config`, saved settings go to
  `gms.config.local.yaml` and are then never loaded — see the `-c` note under
  *Global options*.

---

## Exporting

All three exports read the database and never change your leads. They resume
from a stored position, so running them repeatedly only sends what is new.

### `gms export csv`

| Flag | Default | Meaning |
| --- | --- | --- |
| `-e, --entity <name>` | `leads-flat` | `leads-flat`, `businesses` or `emails` |
| `-o, --out-dir <path>` | `<dataDir>/exports` | Where to write |
| `--full` | off | Re-export everything, replacing the file |
| `--split-by <column>` | off | One file per value, e.g. `state` |
| `--excel-safe` | off | Wrap zips and phones as `="01234"` |
| `--no-bom` | BOM written | Omit the UTF-8 byte-order mark |
| `--crlf` | `\n` | Windows line endings |
| `--json` | off | Machine-readable output |

- Appends, so a run that dies halfway leaves a valid file and the next run
  continues. `--full` replaces the file instead, because restarting the position
  while appending would leave two copies of every row.
- The position advances only after the rows are on disk, and the command
  compares what it wrote against what it counted as pending, failing loudly if
  they disagree.
- **Excel strips leading zeros on double-click** whatever you do. `--excel-safe`
  is the only in-file form Excel reads correctly — at the cost of a file only
  Excel reads correctly. The alternative is File → Import with the column set to
  Text.
- `exporters.csv.excelSafeText` and `exporters.csv.bom` appear in the config
  template but are **not read** — only the flags work. See *Known rough edges*.

### `gms export sheets`

| Flag | Default | Meaning |
| --- | --- | --- |
| `-e, --entity <name>` | `leads-flat` | `leads-flat`, `businesses` or `emails` |
| `-s, --spreadsheet-id <id>` | `exporters.sheets.spreadsheetId` | From the sheet URL |
| `-t, --tab <name>` | `exporters.sheets.sheetName` (`Leads`) | Tab to append to |
| `--full` | off | Re-send everything |
| `--json` | off | Machine-readable output |

- Cells are sent with explicit types, so a ZIP of `02108` and a 20-digit CID
  survive. `valueInputOption: RAW` is the usual advice and it does not work.
- Many rows go in **one** request: the quota is 60 writes per minute for the
  whole service account, and one batch costs one write however many rows it
  carries.
- Creates the tab with a bold, frozen header row if it doesn't exist.
- Refuses rather than half-writes: an export above `exporters.sheets.maxRows`
  (50,000) or larger than the spreadsheet's remaining share of its 10-million-cell
  budget stops before sending anything.
- Retries 429 and 5xx with jittered backoff; gives up immediately on 403, which
  will never fix itself by waiting.
- Setup is in [GOOGLE_SHEETS.md](GOOGLE_SHEETS.md). The step people miss is
  sharing the sheet with the service-account email as an Editor.
- Sheets is a **capped, team-visible window**, not the bulk path. Use CSV for
  volume.

### `gms export status`

Where each export has reached: exporter, entity, position, rows sent, target.
`--json` for the raw rows. Read-only apart from creating the database file if it
does not exist.

For `leads-flat` the position shows as `159/96` — two watermarks, because that
view emits one row per (business, email). The second one is what lets an address
found *after* a business was exported still reach the sheet.

---

## Database maintenance

| Command | What it does |
| --- | --- |
| `gms db migrate [--dry-run]` | Apply pending migrations. Idempotent; `--dry-run` lists what would run |
| `gms db status [--json]` | Database file, size, WAL mode, applied and pending migrations |
| `gms db check` | Full `PRAGMA integrity_check`. Slow on a large database |
| `gms db vacuum` | Compact and reclaim free pages |
| `gms db backup <destination>` | Consistent copy, safe while the database is in use |

Use `gms db backup`, never `cp`: copying an open SQLite database picks up the
`-wal` and `-shm` sidecars inconsistently and yields a file that may not open.

---

## Known rough edges

Behaviour that is currently wrong or misleading, found while writing this file.
Listed so the documentation stays honest; none of them corrupt data you have
already collected.

1. **`GMS_DEBUG=1` breaks every command.** The CLI prints "Set `GMS_DEBUG=1` for
   a stack trace" on failure, but `GMS_` is the config environment prefix and the
   schema is strict, so setting it fails with `Unrecognized key: "debug"` before
   any command runs.
2. **`gms enrich emails` strands work on Ctrl-C.** A site is marked `crawling`
   when claimed and nothing ever resets it — there is no lease or reaper as there
   is for the scrape queue — so anything in flight is never retried.
3. **The dashboard's "Retry all failed" works without `--control`.** It is a
   database write reachable in view-only mode.
4. **The dashboard names a flag that does not exist**, telling you to "restart
   with `--allow-control`". The flag is `--control`.
5. **`-c` on `gms ui` cannot mean `--control`** — the global `--config` shadows it.
6. **`exporters.csv.excelSafeText` and `exporters.csv.bom` do nothing.** Both are
   in the config schema and the starter template; the exporter reads only the
   flags.
7. **The "Rejected" email report is always empty.** Junk addresses are discarded
   before they are stored, so the report — which reads `is_junk = 1` — has
   nothing to show, and a too-aggressive rule cannot be audited.
8. **Ctrl-C during `gms run` does not give in-flight jobs time to finish.**
   `runtime.shutdownGraceSeconds` bounds how long *cleanup* may take; the browser
   pool closes immediately, so in-flight jobs are aborted rather than allowed to
   checkpoint. The config comment says otherwise.
9. **Orphaned Chromium processes are never swept.** The sweeper exists but no
   command calls it, so after a `kill -9` you must clean up by hand.
10. **`gms status --by` silently switches automation** to `google-maps`, and the
    throughput and ETA ignore `-a` entirely — so `gms status -a other` shows one
    automation's counts beside the whole database's throughput.

---

## Developer scripts

Not `gms` commands; run with `npm run`.

| Script | What it does |
| --- | --- |
| `npm run build` | Compile to `dist/`. Required before the `gms` binary exists |
| `npm run gms -- <args>` | Run the CLI from source without building |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm run boundaries` | dependency-cruiser module boundary rules |
| `npm run check` | typecheck + lint + boundaries + test |

To install `gms` on your PATH: `npm run build && npm link`.
