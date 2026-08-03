# gms

A modular web automation platform. Google Maps lead extraction is the first automation; the engine
underneath it is automation-agnostic by design.

This replaces an RTILA workflow that was backed by a Google Sheet and a public Apps Script proxy.
The architecture and full roadmap live in `docs/ARCHITECTURE.md`.

**Status: M0 (Foundation) complete.** Config, logging, database, migrations and the CLI skeleton are
production-ready. There is no scraper yet — that arrives in M3.

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
npm run gms -- init          # write gms.config.yaml and create data/
npm run gms -- db migrate    # create the database
npm run gms -- doctor        # verify the environment
```

After `npm run build`, the CLI is available as `gms` and works from any directory.

## Commands

| Command | Purpose |
| --- | --- |
| `gms init` | Scaffold `gms.config.yaml` and the `data/` tree |
| `gms doctor [--json]` | Verify Node, the native binding, paths, database and migrations |
| `gms config show [--resolved] [--json]` | Print the merged config with secrets redacted |
| `gms db migrate [--dry-run]` | Apply pending migrations |
| `gms db status [--json]` | Database and migration state |
| `gms db check` | Full integrity check |
| `gms db vacuum` | Compact and reclaim free pages |
| `gms db backup <path>` | Consistent copy, safe while the database is in use |

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
