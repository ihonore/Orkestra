# gms

A modular web automation platform. Google Maps lead extraction is the first automation; the engine
underneath it is automation-agnostic by design.

This replaces an RTILA workflow that was backed by a Google Sheet and a public Apps Script proxy.
The architecture and full roadmap live in `docs/ARCHITECTURE.md`.

**Status: usable.** M0–M5 are complete: the scraper runs against live Google Maps, crawls business
websites for email addresses, and exports to CSV. Verified end to end on real data — 2 search jobs
produced 159 businesses with 100% CID/name fill and zero duplicates; enriching their 108 domains
produced 74 usable addresses across 47 businesses.

### The short version

```bash
gms ui --control
```

Everything — managing cities and services, creating jobs, scraping, finding
emails, exporting — runs from that page as a numbered sequence, with a live log
and a stop button. Nothing else needs to be memorised.

The 185 cities and 85 services ship in `seeds/` and load on the first
`gms db migrate`. Add, edit or pause them on the dashboard's **Cities** and
**Services** pages, which also show how far each one has got.

### The same thing from the terminal

```bash
gms plan                       # 185 x 85 = 15,725 jobs
gms run --workers 4            # scrape Google Maps
gms enrich emails --workers 8  # crawl websites for addresses
gms export csv                 # leads-flat.csv
```

### A note on exporting to Excel

A CSV file has no types, so **quoting does not preserve a leading zero** — Excel re-guesses on open
and turns `02108` into `2108`. Two things actually work: pass `--excel-safe` (writes `="02108"`,
which only Excel reads correctly), or open via Excel's import wizard with the column set to Text.
The default is a clean, portable file.

---

## Requirements

- **Node.js 24 LTS** (`>=24.13.0`)
- No compiler toolchain. `better-sqlite3` v13 ships prebuilt binaries inside its npm tarball with no
  install script, so `npm install` works on a bare Windows VPS with no Visual Studio Build Tools.

Supported platforms: macOS, Windows and Linux on x64 or arm64. A 32-bit platform has no prebuilt
binary and `gms doctor` will say so explicitly rather than failing with a module-load stack trace.

> **Linux note:** the glibc prebuilds require GLIBC 2.38 or newer. Debian 12, Ubuntu 22.04 and
> Amazon Linux 2 are too old; use a musl-based image or a newer distribution.

## Getting started

```bash
npm install
npx playwright install chromium   # the scraper needs a browser
npm run build                     # compile to dist/
npm link                          # put `gms` on your PATH
```

Then, from anywhere:

```bash
gms init          # write gms.config.yaml and create data/
gms db migrate    # create the database and load the seeds/ lists
gms doctor --all  # verify the environment, browser and proxies
gms ui --control  # open the dashboard and do everything else there
```

`npm link` creates a symlink into your global npm bin. To remove it later:
`npm unlink -g gms`.

**Without installing**, every command also works as `npm run gms -- <command>`
from the project directory — e.g. `npm run gms -- ui --control`.

## Moving to another machine

**Windows VPS:** copy `scripts/windows/install.cmd` onto it and double-click.
It installs everything, and updates on later runs. See
**[docs/WINDOWS.md](docs/WINDOWS.md)**.

Git carries the code and the `seeds/` lists. It does **not** carry `data/`
(the database, with every lead and every finished search) or `assests/`.
Both are git-ignored, so a fresh clone on the VPS starts with the full city and
service lists and an empty queue.

- **Changed the lists on this machine?** Run `gms seeds save` (or click
  **Save to seeds/** in the dashboard), commit `seeds/`, and pull on the other
  machine. Then run `gms seeds load` there if its database already exists, since
  `migrate` only seeds an empty one.
- **Want the leads and progress too?** Copy the database itself:
  `gms db backup gms-backup.sqlite`, move that file across, and put it at
  `data/gms.sqlite` *before* the first `gms db migrate` there.
- Run the scraper on one machine at a time. Two databases do not merge, so
  pick the VPS as the one that does the real work.

## Commands

Full reference, including every flag and the things that will surprise you:
**[docs/COMMANDS.md](docs/COMMANDS.md)**. `gms help <command>` prints the same
flags from the CLI itself.

| Command | Purpose |
| --- | --- |
| `gms init` | Scaffold `gms.config.yaml` and the `data/` tree |
| `gms doctor [--all]` | Verify Node, the native binding, paths, database, migrations, and — with `--all` — the browser, proxies and Sheets |
| `gms config show [--resolved]` | Print the merged config with secrets redacted |
| `gms seeds load\|save` | Load the committed `seeds/` lists, or write the database's lists back to them |
| `gms import sheets <file>` | List the tabs in a workbook, so you know what to pass to `--sheet` |
| `gms import cities\|categories <file>` | Load seed data from xlsx/CSV, repairing leading zeros |
| `gms plan` | Create jobs from seeds (safe to re-run) |
| `gms queue [--states TX,FL] [--only]` | Choose which searches run first. Spreads across states by default |
| `gms run` | Scrape Google Maps into the database |
| `gms enrich emails` | Crawl business websites for contact addresses |
| `gms status [--by city\|category\|state]` | Queue progress, throughput, ETA |
| `gms jobs list\|retry` | Inspect and steer individual jobs |
| `gms ui [--control]` | Local dashboard — run the whole pipeline from a browser |
| `gms export csv [--entity ...]` | Export results, resuming from the last position |
| `gms export sheets` | Push results to a shared Google Sheet ([setup](docs/GOOGLE_SHEETS.md)) |
| `gms export status` | Where each exporter has reached |
| `gms db migrate\|status\|check\|vacuum` | Database maintenance |
| `gms db backup <path>` | Consistent copy, safe while the database is in use |

Global flags work with any command, before or after it: `-c, --config <path>`,
`--data-dir <path>`, `--log-level <level>`. Most commands also take `--json`.

## Configuration

Precedence, lowest to highest:

```
built-in defaults → gms.config.yaml → gms.config.local.yaml → GMS_* env vars → CLI flags
```

Environment variables use `__` for nesting and SNAKE_CASE for each segment:

```bash
GMS_LOGGING__LEVEL=debug
GMS_DATABASE__BUSY_TIMEOUT_MS=500
```

Secrets belong in the environment, never in a config file. `gms.config.yaml` is meant to be
committed; `gms.config.local.yaml` is gitignored and is the place for personal overrides.

Run `gms config show --resolved` to see exactly what any command will use, including which layers
contributed.

## Database

SQLite in WAL mode is the single source of truth. CSV and Google Sheets will be *exporters*, not
state stores — a failed export can then never lose data, because the database was written first.

Two deliberate choices worth knowing about:

- **`busyTimeoutMs` defaults to 250, not the driver's 5000.** SQLite's busy handler *sleeps the
  calling thread*, and because the driver is synchronous that stalls every worker and timer in the
  process. Contention is handled with application-level retry and jitter instead.
- **The database location is checked at startup.** A network filesystem is refused outright — SQLite
  states that WAL cannot work there, and the failure mode is live corruption. A cloud-synced folder
  (OneDrive, Dropbox, iCloud) is refused by default but can be permitted with
  `database.allowCloudSync: true`; the hazard there is different, and is that sync agents copy the
  file mid-transaction and sync the `-wal`/`-shm` sidecars independently.

Back up with `gms db backup` (which uses `VACUUM INTO`), never by copying the file — a plain copy
taken during a transaction captures a torn state.

## Development

```bash
npm run check        # typecheck + lint + module boundaries + tests
npm test             # vitest
npm run build        # compile to dist/
```

`npm run boundaries` enforces the module graph with `dependency-cruiser`. The rules are what keep
`src/core`, `src/db` and `src/config` extractable into a separate package when the HTTP API becomes
a second deployable:

- `src/core` must not import any specific automation, exporter, importer or the CLI.
- An automation must not import `src/db` — automations *yield* records and the engine persists them,
  which is what makes storage genuinely pluggable.
- Runtime code must not import a devDependency.

Violations fail the build rather than producing a warning.

## Legal

Scraping Google Maps is contrary to Google's Terms of Service. That is a contract matter rather than
a criminal one for public data in the US, but it is a real risk and should be an informed decision.

More operationally binding is what you do with the output. **CAN-SPAM** requires accurate headers, a
valid physical postal address and a working opt-out honoured promptly; it needs no prior consent and
has no B2B carve-out. A suppression list is part of the schema from the start for that reason.
GDPR/ePrivacy makes emailing EU natural persons materially riskier, so keep the seed data US-only
and enforce that at send time rather than at collection time. Note also that the CCPA/CPRA B2B
exemption expired in 2023, so a Californian's work email is covered personal information.

Do not scrape behind a login. Business websites' `robots.txt` is respected by default.
