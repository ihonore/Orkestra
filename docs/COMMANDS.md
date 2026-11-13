# Command reference

Every `gms` command, what it does, and what it does that you would not guess.

The CLI itself is always the last word: `gms --help` lists the commands and
`gms help <command>` (e.g. `gms help export`) prints the flags for one of them.
This file adds the part the help text has no room for — what each command
touches, whether it is safe to re-run, and where it will surprise you.

---

## The short path

Six commands, in the order you use them. Everything else is inspection or
maintenance.

```bash
gms init                                    # 1. create gms.config.yaml and data/
gms db migrate                              # 2. create the database and load seeds/
gms plan                                    # 3. build the queue of searches
gms run                                     # 4. scrape Google Maps
gms enrich emails                           # 5. find addresses on their websites
gms export sheets                           # 6. publish to the team's sheet
```

The 185 cities and 85 services ship in the committed `seeds/` folder, and the
first `gms db migrate` loads them, so there is nothing to import. To use a
different list, see [Seed data](#seed-data).

The queue spreads across states by default, so early leads come from
everywhere. `gms queue --states TX,FL` (or step 3 in the dashboard) puts chosen
states first.

Steps 3–6 are all safe to re-run. `plan` skips searches it already created,
`run` resumes where it stopped, `enrich` skips sites crawled in the last 90
days, and the exports only send what is new.

Prefer clicking to typing? `gms ui --control` puts all of the above behind
buttons in a local web page.

---

## Global options

These belong to `gms` itself, so they work with any command and may go **before
or after** the subcommand — `gms -c alt.yaml status` and `gms status -c alt.yaml`
are the same.

| Flag                    | Meaning                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>` | Config file to read. Default: look in the**current directory** for `gms.config.yaml`, then `.yml`, then `.json` |
| `--campaign <name>`   | Run the campaign in `campaigns/<name>/`, exactly as if gms were started in that folder: its config, local config, lists and database. Cannot be combined with `-c` |
| `--data-dir <path>`   | Override`project.dataDir` for this one invocation                                                                         |
| `--log-level <level>` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`                                                    |
| `-v, --version`       | Print the version and exit — including after a subcommand, so`gms run -v` prints the version instead of running          |
| `-h, --help`          | Usage for the command it follows                                                                                            |

Three things about config discovery that cost real time when you don't know them:

- **There is no upward search.** The config is looked for in the directory your
  shell is in, not in any parent. Run `gms status` from `docs/` and it finds no
  config, silently falls back to built-in defaults, and reports on an empty
  `docs/data/gms.sqlite` it just created. `cd` to the project root first.
- **`-c` disables the local overlay.** With auto-discovery, `gms.config.local.yaml`
  is layered on top of `gms.config.yaml`. Naming a file explicitly loads that one
  file only, so the same machine can give two different answers.
- **`gms ui --control` has no short form.** `-c` belongs to `--config` here as
  everywhere else, so it cannot also mean `--control`.

- **`--campaign` keeps the local overlay.** Unlike `-c`, it reads the campaign
  folder's `gms.config.local.yaml` too, and the dashboard writes its settings
  there. It works from any directory.

Almost every command takes `--json` for machine-readable output. The exceptions
are `gms import sheets`, `gms jobs retry`, `gms db check`, `gms db vacuum` and
`gms db backup`, which reject it as an unknown option.

---

## Setup

### `gms init`

Writes the starter `gms.config.yaml` and creates `data/`, `data/logs/`,
`data/artifacts/` and `data/exports/`.

| Flag            | Default | Meaning                                              |
| --------------- | ------- | ---------------------------------------------------- |
| `-f, --force` | off     | Overwrite an existing config with the stock template |

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

| Flag          | Default | Meaning                                              |
| ------------- | ------- | ---------------------------------------------------- |
| `--proxies` | off     | Probe every proxy, report egress IP, geo and latency |
| `--browser` | off     | Launch Chromium to prove it works                    |
| `--sheets`  | off     | Verify Google Sheets credentials and access          |
| `--all`     | off     | All of the above                                     |
| `--json`    | off     | Machine-readable report                              |

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

| Flag           | Default | Meaning                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------- |
| `--resolved` | off     | Also print resolved paths, the layers that contributed, and a config fingerprint |
| `--json`     | off     | JSON instead of YAML                                                             |

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

The city and service lists live in two places, on purpose:

- **`seeds/cities.csv` and `seeds/services.csv`**, committed with the code. They
  are where a *new* database starts, so a fresh checkout on another machine
  (the Windows VPS, say) has the lists without carrying the spreadsheet over.
- **The database**, which is the working copy. The dashboard's **Cities** and
  **Services** pages add, edit, pause and delete rows here, and show how many
  of each row's searches are done.

The two do not sync on their own. Edits made in the dashboard stay in that
machine's database until you run `gms seeds save` (or click **Save to seeds/**)
and commit the folder.

### `gms seeds load` · `gms seeds save`

`load` upserts `seeds/` into the database. `save` writes the database's lists,
paused rows included, back to `seeds/`.

| Flag     | Default | Meaning                 |
| -------- | ------- | ----------------------- |
| `--json` | off     | Machine-readable output |

- `gms db migrate` runs the equivalent of `load` **once per database**, and only
  into empty tables. An existing database is never overwritten, and deleting
  every city on purpose is not undone by the next migrate.
- `load` matches rows by zip and service name, like `gms import`. It adds and
  updates, **never deletes**, and never changes whether an existing row is
  paused. The files' `Active` column is applied only to rows it inserts.
- `save` writes both files every time, sorted by state and city, so the git
  diff shows exactly what changed. Each file is written to a temporary name and
  renamed, so an interrupted save cannot leave half a file behind.
- `save` writes into the installation's own `seeds/` folder, wherever `gms` was
  run from.

### Editing in the dashboard

The **Cities** and **Services** pages (`gms ui --control`) list every row with
its searches done out of planned, leads found, last search and status.

- **Add** a city with its zip, state code and coordinates, pasted as
  `latitude, longitude`. That is what Google Maps copies when you right-click
  the city and click the numbers. Once a queue exists, the new row's searches
  are queued straight away against every active row of the other list.
- **Edit** rewrites the searches that have not run yet (queued, paused or
  failed). Finished searches keep what they actually searched.
- **Pause** parks the row's queued searches as `paused`, so nothing more is
  searched for it. Resume puts them back in their old place in the queue, and
  creates any pairs it missed while paused. A pair stays paused while either
  side is paused.
- **Delete** removes the row and its planned searches, but only if it never
  produced a lead. Once it has, deleting is refused and the page says to pause
  instead, because a lead's origin points at that row.
- Status is one of: not planned, queued, running, in progress, needs retry
  (only failed searches left), complete, paused (you paused it), or on hold
  (active, but outside the states the queue is limited to; see `gms queue`).

### `gms import sheets <file>`

Lists the tab names inside an `.xlsx`, so you know what to pass to `--sheet`.

- Read-only; opens no database and reads no config.
- The listed order *is* the numbering: the third tab is `--sheet 3`.
- `.xlsx` only. On a `.csv` it fails with the library's raw wording,
  *"Doesn't look like an `.xlsx` file"*.
- No `--json`.

### `gms import cities <file>` · `gms import categories <file>`

Load the seed lists that `gms plan` pairs up.

| Flag                   | Default   | Meaning                          |
| ---------------------- | --------- | -------------------------------- |
| `-s, --sheet <name>` | first tab | Tab name, or 1-based position    |
| `--dry-run`          | off       | Parse and report without writing |
| `--json`             | off       | Machine-readable output          |

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
- A corrected row also reaches the searches already queued for it: queued,
  paused and failed jobs are rewritten, and the count is shown as "queued jobs
  refreshed". Before this, a fixed coordinate only reached jobs planned later.
- An optional `Active` column (`yes`/`no`) sets whether a *new* row starts
  paused. It never changes an existing row.
- One transaction: Ctrl-C leaves the database exactly as it was.
- **Rows you delete from the spreadsheet are not deleted here.** Import only adds
  and updates; retire a city by pausing it on the Cities page.
- Re-importing overwrites with blanks too — a column you cleared in Excel clears
  in the database.
- `--sheet` is silently ignored for `.csv` files, and a numeric `--sheet` is
  always read as a position, so a tab literally named `2` cannot be selected.

---

## Building and running the queue

### `gms plan`

Pairs every selected city with every selected category and writes one job per
pair. 185 cities × 85 categories = 15,725 jobs.

| Flag                      | Default               | Meaning                                             |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `-a, --automation <id>` | `google-maps`       | Which automation the jobs belong to                 |
| `--cities <list>`       | every active city     | Comma-separated names, ZIPs**or** state codes |
| `--categories <list>`   | every active category | Comma-separated names or slugs                      |
| `--limit <n>`           | no cap                | Keep only the top-priority pairs                    |
| `--dry-run`             | off                   | Report what would be created, write nothing         |
| `--json`                | off                   | Machine-readable output                             |

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

### `gms queue`

Shows or changes which searches run first. With no options it only reports
the plan and the next ten searches.

| Flag              | Default  | Meaning                                                       |
| ----------------- | -------- | ------------------------------------------------------------- |
| `--order <order>` | `spread` | `spread`: round-robin across states. `by-state`: one at a time, alphabetically. `chosen`: the `--states` one after another, in the order given |
| `--states <list>` | none     | State codes to favour, e.g. `TX,FL,CA`. `""` clears them       |
| `--only`          | off      | Search only `--states`. The rest wait, shown as "on hold"      |
| `--all`           | —        | Undo `--only`: search every state again                       |
| `--json`          | off      | Machine-readable output                                       |

- **Why it exists.** Every job used to have the same priority, so the queue ran
  in the order `plan` created it: state by state, alphabetically. The first
  days of a sweep that takes weeks went to Alabama and Alaska only.
- **`spread`** (the default) gives every state one search per round, rotating
  through its cities and through the services. The first ~47 searches cover
  ~47 states with different services. A state with many finished searches
  starts that many rounds later, so the backlog evens out.
- **`by-state`** is the old behaviour: finish one state, then the next.
- **`chosen`** runs the `--states` one after another, in the order given:
  every search in the first before any in the second, whatever the service
  weights. Inside each, services still go by weight. Gobadiz uses it to open
  Île-de-France département by département:
  `gms --campaign gobadiz queue --order chosen --states 93,94,95,91,92`.
- **Chosen states** run before the rest (still spread between themselves), or,
  with `--only`, are the only ones that run. Leaving "only" mode resumes the
  others. A city or service you paused yourself stays paused in every mode.
- A service's **weight** still wins over position: a weight-2 service runs
  everywhere before any weight-1 search, except across `chosen` states.
- The plan is stored in the database. `gms run`, the dashboard and `gms plan`
  all apply it, and a change takes effect from the next search a running
  scrape picks up, with no restart.
- The dashboard has the same control as step 3 on the Control page, with a
  "Next up" preview.

### `gms run`

Works through the queue: opens Chromium, walks the Maps results for each
search, saves what it finds.

| Flag                      | Default                 | Meaning                       |
| ------------------------- | ----------------------- | ----------------------------- |
| `-a, --automation <id>` | `google-maps`         | Which queue to work           |
| `-w, --workers <n>`     | `runtime.workers` (4) | Concurrent browser workers    |
| `-n, --max-jobs <n>`    | no limit                | Stop after this many searches |
| `--headful`             | off                     | Show the browser window       |
| `--json`                | off                     | Machine-readable summary      |

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
- A search scrolls until Maps shows "end of the list", or until nothing new
  arrives in three rounds **at the bottom of the list**, waiting 1.2–2.5 s
  each time for the next batch of 20. Before this fix, rounds spent scrolling
  through the first batch also counted, so about half of all searches stopped
  at 20 results.
- **Each search stops at 120 listings**, hardcoded. A dense city + category is
  silently truncated.
- **It exits 0 even if every job failed.** Judge by "jobs failed" in the summary
  or `gms jobs list --status failed`, never by the exit code.
- Ctrl-C stops taking new work and lets in-flight jobs finish and checkpoint —
  bounded by `runtime.shutdownGraceSeconds` (30s) — before the browsers close.
  A job that cannot finish in time is returned to the queue with its checkpoint,
  so it resumes rather than restarts, and the run exits within a few seconds of
  the deadline. Measured: 13s from Ctrl-C to exit, four in-flight jobs returned,
  no browsers left behind.
- A second Ctrl-C exits immediately with code 130 and abandons what was running;
  the reaper recovers those leases once they expire (`runtime.jobLeaseSeconds`,
  300s), keeping their checkpoints.
- At startup it kills Chromium processes orphaned by a previous run. Only
  genuine orphans, and only ones this project launched, so a second `gms run`
  working the same queue is unaffected. This mostly matters on Windows: on macOS
  and Linux Playwright's own pipe-based cleanup already takes the browser down
  with a `kill -9`ed launcher, but `taskkill /F` on Windows does not.

```bash
gms run                          # work the whole queue
gms run --max-jobs 3 --headful   # watch three searches happen
gms run --workers 2              # gentler on a small VPS
```

### `gms enrich emails`

Visits the websites `gms run` collected and looks for contact addresses.

| Flag                      | Default                      | Meaning                    |
| ------------------------- | ---------------------------- | -------------------------- |
| `-w, --workers <n>`     | `runtime.httpWorkers` (16) | Concurrent HTTP workers    |
| `-n, --max-domains <n>` | no limit                     | Stop after this many sites |
| `--json`                | off                          | Machine-readable summary   |

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
- Government also covers local-government `.us` domains (`*.tx.us`), tribal
  `.nsn.us`, `cityof…`/`townof…` domains, and offices such as `mayor@` and
  `elections@` wherever they are hosted. A bare `.us` is not enough: plenty of
  businesses use one. A government body on an ordinary domain with ordinary
  mailboxes can still get through; add it to
  `enrichment.websiteEmails.validation.blockedDomains`.
- Mailboxes nobody answers for business are rejected too: `privacy@` and its
  variants (`dataprivacy@`, `privacyofficer@`), `legal@`, `compliance@`, `dmca@`,
  `copyright@`, `abuse@`, `noreply@`, `unsubscribe@`, `postmaster@`, `webmaster@`.
  The exception is a firm whose trade is the word: `legal@jdwcounsel.com` stays.
  New rules also apply to stored addresses, on `gms db migrate` and whenever the
  email crawl starts.
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
- Ctrl-C hands the site being crawled back to the queue. A process killed
  outright leaves it claimed, and the next `gms enrich emails` reclaims anything
  held longer than five times the per-domain time budget.
- Addresses the rules reject are stored, unlinked and never exported, and
  summarised under "Rejected" — so a rule that is too aggressive is visible
  rather than silent.

---

## Watching progress

### `gms status`

How far the run has got, and roughly how long the rest will take.

| Flag                      | Default | Meaning                                                 |
| ------------------------- | ------- | ------------------------------------------------------- |
| `-a, --automation <id>` | all     | Restrict the counts to one automation                   |
| `--by <grouping>`       | off     | Per-group breakdown:`city`, `category` or `state` |
| `--incomplete`          | off     | With`--by`, hide groups with nothing left             |
| `-n, --limit <n>`       | 1000    | With`--by`, maximum groups to show                    |
| `--json`                | off     | Machine-readable output                                 |

- Read-only for your data, and safe to run while a scrape is in progress —
  SQLite readers don't block the writer.
- The ETA uses only jobs finished in the **last 60 minutes**, so cold early jobs
  and yesterday's numbers don't skew it. At the very start of a run there is no
  throughput block at all; that's expected.
- Statuses with a count of zero are hidden, except `pending` and `done` which
  always print.
- With no jobs at all it stops and points you at `gms plan`.
- `--incomplete` and `-n` are silently ignored unless `--by` is present.
- `--by` needs one automation and falls back to `google-maps`, while plain
  `gms status` totals every automation. It says so when it does.

### `gms jobs list`

| Flag                      | Default | Meaning                                                                |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `-a, --automation <id>` | all     | Restrict to one automation                                             |
| `-s, --status <status>` | all     | `pending`, `leased`, `done`, `failed`, `skipped`, `paused` |
| `--error-kind <kind>`   | all     | e.g.`lease_expired`, `blocked`                                     |
| `-n, --limit <n>`       | 50      | Maximum rows                                                           |
| `--json`                | off     | Machine-readable output                                                |

Read-only. `gms jobs list --status failed --error-kind blocked` is the fastest
way to tell "Google is rate-limiting me" from "this selector broke".

### `gms jobs retry [ids...]`

Puts failed or paused searches back in the queue.

| Flag                      | Default                   | Meaning                           |
| ------------------------- | ------------------------- | --------------------------------- |
| `-a, --automation <id>` | all                       | Restrict to one automation        |
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
- Searches of a **paused city or service stay paused**: they are parked again
  straight after the retry, and the command says how many. Resume the city or
  service to run them. The dashboard's "Retry all failed" retries `failed` only.
- Resetting attempts to 0 is the point and also the risk — a job that failed
  three times for a permanent reason will now fail three more.
- No `--json`.

### `gms ui`

A local web page showing progress, leads, failures and exports — and, with
`--control`, buttons that run the commands for you.

| Flag                     | Default | Meaning                                                            |
| ------------------------ | ------- | ------------------------------------------------------------------ |
| `-p, --port <n>`       | 4600    | Port to listen on                                                  |
| `--no-open`            | off     | Don't open a browser window                                        |
| `--control`            | off     | Let the page start scrapes, imports and exports, and edit settings |
| `--allow-config-write` | off     | Edit settings only, without task controls                          |

- Occupies the terminal until Ctrl-C. The first four lines tell you the URL, the
  exact database file, and whether controls and settings are enabled — read
  those two words to confirm which mode you got.
- **Binds to 127.0.0.1 only, and has no password.** That is the trade: the page
  shows names, phone numbers and addresses and can edit settings, so it is never
  reachable from another machine. Do not put it behind a public proxy.
- It also refuses requests from **other websites** open in the same browser. A
  request whose `Host` is not this server is refused, which defeats DNS
  rebinding. So is a write whose `Origin` or `Sec-Fetch-Site` says it came from
  another site. Before this, any page you visited could start a scrape or
  rewrite settings with a plain `text/plain` POST. curl and scripts send neither
  header and still work.
- On a VPS, open it from a browser on the VPS itself (over Remote Desktop), or
  tunnel the port: `ssh -L 4600:127.0.0.1:4600 you@vps`, then browse to
  `http://127.0.0.1:4600` locally.
- Reads open the database read-only and close immediately, so leaving it open for
  days won't block a running scrape.
- **Stop** asks the process to stop over an IPC channel rather than with a
  signal, because Windows has no SIGTERM: `kill()` there terminates outright,
  skipping the handler that finishes in-flight searches and closes the browser.
  A task still running `runtime.shutdownGraceSeconds` + 30 s later is killed.
  Closing the dashboard, or losing it, stops its tasks the same way.
- **Autopilot** (top of the Control page) runs the pipeline unattended: it keeps
  the scrape going while searches are queued, starts **Find emails** once
  25 websites are waiting, and sends new leads to the sheet every 500 rows or
  every 2 hours, whichever comes first, and once everything has finished.
  - It presses the same buttons you would, with the same limits, and never
    starts a second copy of a step that is running.
  - It starts nothing new while free memory is under 1,024 MB.
  - A step that fails waits 2 minutes, then 4, 8, and so on up to an hour,
    rather than being restarted in a loop. The panel shows why, in red, and
    **Activity** keeps recent finished tasks so their logs can be opened.
  - Pressing **Stop** on a step turns autopilot off, so it does not restart
    what you just stopped.
  - Its settings live in the database. Left on, it resumes when the
    dashboard starts, so after a VPS reboot it carries on at sign-in.
  - **Recommended settings** restores the defaults, which are sized for the
    7 GB production VPS: 4 scrape workers, 8 email workers.
- **Step 7 sets up Google Sheets** without editing files. A pasted sheet link
  and tab name go to `gms.config.local.yaml`. A chosen key file is checked to be
  a service-account key (an OAuth client secret is refused by name), saved to
  `~/gms-credentials/gms-exporter.json` readable only by you, and recorded as
  `~/gms-credentials/gms-exporter.json` so the same line works on any machine.
  The page only ever sees the key's address. **Test connection** runs the
  checks of `gms doctor --sheets`. These settings apply immediately, with no
  restart. Choosing a key replaces the one already at that path.
- Buttons launch real `gms` commands as separate processes from a fixed
  allow-list with typed parameters — never a free-text command line — so a crash
  in the scraper can't take the dashboard down.
- Typed values are clamped, not rejected: browser workers 1–32, email workers
  1–64, max jobs 1–100,000. Asking for 500 workers silently gives 32.
- One task of each kind at a time; a second Scrape returns HTTP 409.
- `--control` has no short form: `-c` is the global `--config`.
- Without `--control` the dashboard is genuinely read-only. Every button that
  writes, including "Retry all failed", is refused.
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

Entities:

- **`leads-by-business`**: one row per business that has an email. `email` holds
  the best address, and `other_emails` lists the rest, best first. "Best" means
  a named person at the business's own domain, then a role address there
  (info@, contact@), then other business mail, then free mail like Gmail. A
  business is sent once, with all the addresses its website crawl found. One
  that gains an address on a recrawl months later is not sent again.
  Departments that reach a person but not a buyer (careers@, billing@, press@)
  rank below every other address.
- In every lead export, an address is left out for a business when it belongs
  to someone else: a generic or system mailbox on a domain unrelated to the
  business's website and name, such as `support@overfuel.com` on a dealer's
  site or `contact@bizsite.link` on a site built with it. People at a parent
  group (`jeffswickard@swickard.com`) and the business's own second domains
  (`info@rmgaragedoors.com` for Red Mountain Garage Doors) are kept. This is
  judged when the email is found, and again for stored emails each time the
  email crawl starts and on `gms db migrate`.
- `leads-with-email`: one row per address, only businesses with an email.
- `leads-flat`: one row per address, plus businesses with none yet. Such a
  business is a blank row now, then a second row once an email is found.
- `businesses` and `emails`.
- **`prospects`**: for a campaign with `qualify` on (Gobadiz). One row per
  wanted lead, with French headers, sent once its email search is over,
  **with or without an email**. It carries a Priorité (A/B/C) and the
  Instagram and booking-platform columns. Its position is the lead's
  `lead_seq`, so each lead is sent exactly once. See
  [campaigns/gobadiz/README.md](../campaigns/gobadiz/README.md).
- Every lead export leaves out what is on the opt-out list: suppressed
  addresses, domains, phones and listings (`gms suppress`).

The sheet's **layout** setting (`exporters.sheets.layout`: `business`, `email`,
`all` or `prospects`, set in step 7) chooses among the lead views for `gms export sheets`,
the dashboard's button and autopilot alike. The default is `business`, written
to its own tab, `exporters.sheets.businessSheetName` ("Leads by business"),
because its columns differ. The two per-address exports share a tab and a
position, so neither re-sends what the other sent.

### `gms export csv`

| Flag                     | Default               | Meaning                                      |
| ------------------------ | --------------------- | -------------------------------------------- |
| `-e, --entity <name>`  | `leads-flat`        | `leads-flat`, `businesses` or `emails` |
| `-o, --out-dir <path>` | `<dataDir>/exports` | Where to write                               |
| `--full`               | off                   | Re-export everything, replacing the file     |
| `--split-by <column>`  | off                   | One file per value, e.g.`state`            |
| `--excel-safe`         | off                   | Wrap zips and phones as`="01234"`          |
| `--no-bom`             | BOM written           | Omit the UTF-8 byte-order mark               |
| `--crlf`               | `\n`                | Windows line endings                         |
| `--json`               | off                   | Machine-readable output                      |

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
- `exporters.csv.excelSafeText` and `exporters.csv.bom` set the defaults;
  `--excel-safe` and `--no-bom` override them for one run.

### `gms export sheets`

| Flag                          | Default                                    | Meaning                                      |
| ----------------------------- | ------------------------------------------ | -------------------------------------------- |
| `-e, --entity <name>`       | from `exporters.sheets.layout`           | any entity above                       |
| `-s, --spreadsheet-id <id>` | `exporters.sheets.spreadsheetId`         | From the sheet URL                           |
| `-t, --tab <name>`          | `exporters.sheets.sheetName` (`Leads`) | Tab to append to                             |
| `--full`                    | off                                        | Re-send everything                           |
| `--json`                    | off                                        | Machine-readable output                      |

- Cells are sent with explicit types, so a ZIP of `02108` and a 20-digit CID
  survive. `valueInputOption: RAW` is the usual advice and it does not work.
- Many rows go in **one** request: the quota is 60 writes per minute for the
  whole service account, and one batch costs one write however many rows it
  carries.
- Creates the tab with a bold, frozen header row if it doesn't exist.
- Sends at most `exporters.sheets.maxRows` (50,000) rows per run; a bigger backlog
  carries on next run from where it stopped. An export larger than the
  spreadsheet's remaining share of its 10-million-cell budget stops before
  sending or clearing anything.
- A lead found, or re-judged away, by the email crawl during a send is not an
  error: the send sends what the view holds at that moment.
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

## Campaign leads

### `gms qualify`

Applies the campaign's `qualify` rules to every stored business, and reports
what they did. The same pass runs on its own before every email crawl and
every export, so this command is for looking, not something to remember.

Each business gets:
- a **specialty**, from its Google category through `categoriesFile`, else
  from the search that found it;
- an **exclusion reason** when the campaign does not want it: closed, a chain
  (`exclusionsFile`, or `chainSiteThreshold` listings sharing one website), an
  excluded category, a name rule, or out of area (`activeAreasOnly`: no active
  city in its département);
- a **lead_seq** once it is wanted and its website has been crawled, or it
  has none worth crawling.

The website of a business that is not wanted leaves the crawl queue, and comes
back when a rule change or a newly activated city makes it wanted. The report
lists Google categories missing from the category map.

Off unless `qualify.enabled` is set. The main campaign has it off.

### `gms suppress add|list|remove`

The opt-out list. `add` takes any number of emails, phone numbers (in any
format: they are normalised for the campaign's country) and websites; `-r`
records why. Every lead export leaves them out from then on, and the crawler
skips a suppressed website. `remove` undoes a mistake. The dashboard's Leads
page has the same box.

## Database maintenance

| Command                         | What it does                                                            |
| ------------------------------- | ----------------------------------------------------------------------- |
| `gms db migrate [--dry-run]`  | Apply pending migrations. Idempotent;`--dry-run` lists what would run |
| `gms db status [--json]`      | Database file, size, WAL mode, applied and pending migrations           |
| `gms db check`                | Full`PRAGMA integrity_check`. Slow on a large database                |
| `gms db vacuum`               | Compact and reclaim free pages                                          |
| `gms db backup <destination>` | Consistent copy, safe while the database is in use                      |

The first `gms db migrate` on a new database also loads `seeds/` (see
[Seed data](#seed-data)).

After the update that fixed names and websites being taken from other places,
`gms db migrate` also re-queues every finished search, once per database, so
those businesses are read again and corrected in place. While any of those
searches is still waiting, autopilot sends nothing to the sheet. The panel
shows "holding until the re-scrape finishes: N of M searches re-read", and
sending resumes by itself afterwards. The **Re-scrape finished searches**
button on the Issues page does the same on demand.

When an update changes rows the sheet already has, migrate asks for the tab to
be **rebuilt** once: every value below its header is blanked and sent again from
scratch, keeping the rows' colours. Autopilot does this at its next chance (after
any re-scrape), any other send of that export does it first, and
`gms export sheets --rebuild` does it on demand. It clears the tab only once: if
sending fails afterwards, the next send resumes from where it stopped. Anything
typed into the tab's rows is lost, in any column, so keep notes in another tab.

Use `gms db backup`, never `cp`: copying an open SQLite database picks up the
`-wal` and `-shm` sidecars inconsistently and yields a file that may not open.

---

## Fixed here

Writing this reference turned up ten defects; reviewing the fixes for them
turned up twelve more, several of them regressions in the fixes themselves.
All are fixed, and everything described above is the fixed behaviour — listed
so that anyone comparing against an older build knows what changed.

**Stopping a run** was the worst of it, and nothing about it worked:

1. Playwright installed its own signal handlers. Its SIGINT handler closed every
   browser and called `process.exit(130)` outright, so the graceful stop never
   got past starting — no checkpoint, no summary, no database close. Its SIGTERM
   and SIGHUP handlers were quieter and worse: they closed the browser under jobs
   that were still running. The tool now owns those signals.
2. Ctrl-C closed the browser immediately, so in-flight jobs died mid-page instead
   of committing what they had. They now drain first.
3. That drain then had no deadline of its own. Losing the shutdown controller's
   race only logs — it cancels nothing — and closing the browser is the only
   thing that unwedges a job stuck in a Playwright call, so a wedged job would
   have hung the process forever with Chromium alive.
4. An abort during search or feed harvest returned *success* with zero results,
   because the only abort check sat inside the per-listing loop and an empty list
   never enters it. Four real jobs were marked done with `result_count` 0 after
   one Ctrl-C. Those four cities and categories would never have been scraped
   again.
5. Interrupted jobs were left leased for the full 300-second lease, so stopping a
   run and restarting it found an apparently empty queue. They are now returned
   to the queue at once, fenced, with their checkpoints.
6. Nothing exited afterwards. Playwright's `process.exit(130)` had been hiding a
   leaked handle; with that gone, a stopped run stayed alive indefinitely.

**Enrichment** had the same shape of problem:

7. Ctrl-C stranded the site being crawled as `crawling` forever — the claim only
   ever looks at `pending`, and there was no reaper.
8. The crawler never throws, so an interrupted crawl was committed as a
   *successful* one: status `done`, zero emails, and a 90-day recrawl cooldown.
9. Adding a reaper reintroduced the hazard the job queue guards against — the
   worker it declares dead may be alive. The domain queue now carries a fencing
   token, like `jobs.lease_epoch`.
10. The lease was sized off `maxTimePerDomainMs`, which does not bound how long a
    claim is held: a site asking for `Crawl-delay: 30` holds one far longer.

**Everything else:**

11. `GMS_DEBUG=1`, which the CLI itself tells you to set when a command fails,
    broke every command — `GMS_` is the config environment prefix and the schema
    is strict, so it died with `Unrecognized key: "debug"`.
12. The dashboard's "Retry all failed" wrote to the database without `--control`,
    and the button stayed enabled in view-only.
13. The dashboard told you to "restart with `--allow-control`". No such flag.
14. `-c` on `gms ui` was advertised as `--control` and could never mean it.
15. `exporters.csv.excelSafeText` and `exporters.csv.bom` shipped in the starter
    config and were read by nothing.
16. Rejected addresses were discarded before they were stored, so the "Rejected"
    report — which counts them — was always empty and no validation rule could be
    audited.
17. Storing them then exposed a second bug: the upsert never refreshed
    `is_role`/`is_free`, so an address first seen as a reject and later accepted
    kept the placeholder flags — exactly what re-running with better rules does.
18. Orphaned Chromium was never swept: the sweeper existed but nothing called it,
    it had no safe way to tell our browsers from anyone else's, and its Windows
    branch filtered on `chrome.exe` when the default launch is
    `chrome-headless-shell.exe`. Chiefly a Windows fix — Playwright's own cleanup
    already handles `kill -9` on macOS and Linux.
19. `gms status --by` switched automation without saying so, the throughput and
    ETA ignored `-a` entirely, and the grouped `--json` gave no sign of either.

---

## Developer scripts

Not `gms` commands; run with `npm run`.

| Script                                | What it does                                                   |
| ------------------------------------- | -------------------------------------------------------------- |
| `npm run build`                     | Compile to`dist/`. Required before the `gms` binary exists |
| `npm run gms -- <args>`             | Run the CLI from source without building                       |
| `npm test` / `npm run test:watch` | Vitest                                                         |
| `npm run typecheck`                 | `tsc --noEmit`                                               |
| `npm run lint` / `lint:fix`       | ESLint                                                         |
| `npm run format` / `format:check` | Prettier                                                       |
| `npm run boundaries`                | dependency-cruiser module boundary rules                       |
| `npm run check`                     | typecheck + lint + boundaries + test                           |

To install `gms` on your PATH: `npm run build && npm link`.
