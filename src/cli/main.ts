#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Commands are thin: they parse flags, load config once, call into the library,
 * and format the result. All behaviour lives under `src/core`, `src/db` and
 * `src/config` so the forthcoming HTTP API can expose the same operations
 * without going through argv.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadConfig } from '../config/loader.js';
import type { LogLevel, ResolvedConfig } from '../config/schema.js';
import { errorMessage, isAppError } from '../core/errors/taxonomy.js';
import { campaignDir, displayPath } from '../core/util/paths.js';
import { listenForParentStop } from '../core/engine/shutdown.js';
import { APP_VERSION } from '../version.js';
import { runConfigShow } from './commands/config.js';
import { runDbBackup, runDbCheck, runDbMigrate, runDbStatus, runDbVacuum } from './commands/db.js';
import { runDoctor } from './commands/doctor.js';
import { runEnrichEmails } from './commands/enrich.js';
import { runExportCsv, runExportSheets, runExportStatus } from './commands/export.js';
import { runUi } from './commands/ui.js';
import { runImportCategories, runImportCities, runListSheets } from './commands/import.js';
import { runInit } from './commands/init.js';
import { runPlan } from './commands/plan.js';
import { runQueue } from './commands/queue.js';
import { runQualify } from './commands/qualify.js';
import { runSuppressAdd, runSuppressList, runSuppressRemove } from './commands/suppress.js';
import { runSeedsLoad, runSeedsSave } from './commands/seeds.js';
import { runRun } from './commands/run.js';
import { runJobsList, runJobsRetry, runStatus } from './commands/status.js';
import { style, symbol } from './output.js';
import type { JobStatus } from '../db/repositories/jobs.js';
import type { GroupingName } from '../db/repositories/progress.js';

interface GlobalOptions {
  readonly config?: string;
  readonly campaign?: string;
  readonly logLevel?: LogLevel;
  readonly dataDir?: string;
}

/**
 * Load config using the global flags.
 *
 * Flags become the highest-precedence overlay rather than mutating the parsed
 * result, so `gms config show` reports exactly what any other command would use.
 */
function configFrom(program: Command): ResolvedConfig {
  const options = program.opts<GlobalOptions>();
  const overrides: Record<string, unknown> = {};
  if (options.logLevel !== undefined) overrides['logging'] = { level: options.logLevel };
  if (options.dataDir !== undefined) overrides['project'] = { dataDir: options.dataDir };

  return loadConfig({
    ...(options.config !== undefined ? { configFile: options.config } : {}),
    ...(options.campaign !== undefined ? { cwd: campaignRoot(options) } : {}),
    overrides,
  });
}

/**
 * The folder `--campaign <name>` runs from.
 *
 * A campaign is used exactly as if gms had been started inside its folder:
 * its `gms.config.yaml`, its `gms.config.local.yaml` (where the dashboard
 * saves settings) and its data directory. Tasks the dashboard starts run in
 * the same folder, so they pick up the same campaign with no flag to forward.
 */
function campaignRoot(options: GlobalOptions): string {
  const name = options.campaign ?? '';
  if (options.config !== undefined) {
    throw new InvalidArgumentError('use --campaign or --config, not both');
  }
  let dir: string;
  try {
    dir = campaignDir(name);
  } catch (error) {
    throw new InvalidArgumentError(errorMessage(error));
  }
  if (!existsSync(path.join(dir, 'gms.config.yaml'))) {
    throw new InvalidArgumentError(
      `no campaign "${name}": ${displayPath(path.join(dir, 'gms.config.yaml'))} does not exist`,
    );
  }
  return dir;
}

const JOB_STATUS_CHOICES: readonly string[] = [
  'pending',
  'leased',
  'done',
  'failed',
  'skipped',
  'paused',
];

/** Parse a `--limit` style flag, rejecting nonsense rather than passing NaN on. */
function toInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return n;
}

/** Split a comma-separated flag, dropping blanks from trailing commas. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * A `--sheet` flag is a name or a 1-based index.
 *
 * A sheet legitimately named "2" is indistinguishable from index 2 here; the
 * numeric reading wins, which is the far more common intent.
 */
function sheetSelector(value: string): string | number {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
}

function fail(error: unknown): never {
  if (isAppError(error)) {
    console.error(`${symbol.fail} ${error.message}`);
    if (error.hint !== undefined) {
      console.error(`\n${style.grey(error.hint)}`);
    }
    if (process.env['GMS_DEBUG'] !== undefined && error.cause !== undefined) {
      console.error(`\n${style.grey(errorMessage(error.cause))}`);
    }
  } else {
    console.error(`${symbol.fail} ${errorMessage(error)}`);
    if (process.env['GMS_DEBUG'] !== undefined && error instanceof Error) {
      console.error(error.stack ?? '');
    } else {
      console.error(style.grey('\nSet GMS_DEBUG=1 for a stack trace.'));
    }
  }
  process.exit(1);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('gms')
    .description('Modular web automation platform. Google Maps lead extraction is automation #1.')
    .version(APP_VERSION, '-v, --version')
    .option('-c, --config <path>', 'path to a config file (default: ./gms.config.yaml)')
    .option(
      '--campaign <name>',
      'run a campaign from campaigns/<name>/ (its own config, lists and database)',
    )
    .option('--data-dir <path>', 'override project.dataDir')
    .addOption(
      new Option('--log-level <level>', 'override logging.level').choices([
        'trace',
        'debug',
        'info',
        'warn',
        'error',
        'fatal',
      ]),
    )
    .showHelpAfterError();

  program
    .command('init')
    .description('create gms.config.yaml and the data directory')
    .option('-f, --force', 'overwrite an existing config file', false)
    .action((options: { force: boolean }) => {
      runInit({ cwd: process.cwd(), force: options.force });
    });

  program
    .command('doctor')
    .description('verify the environment, database and migrations')
    .option('--proxies', 'probe every configured proxy and report egress IP', false)
    .option('--browser', 'launch Chromium to prove it works', false)
    .option('--sheets', 'verify Google Sheets credentials and access', false)
    .option('--all', 'run every check, including the slow ones', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: {
        proxies: boolean;
        browser: boolean;
        sheets: boolean;
        all: boolean;
        json: boolean;
      }) => {
        const { failed } = await runDoctor({
          config: configFrom(program),
          json: options.json,
          proxies: options.proxies || options.all,
          browser: options.browser || options.all,
          sheets: options.sheets || options.all,
        });
        if (failed) process.exit(1);
      },
    );

  const config = program.command('config').description('inspect configuration');
  config
    .command('show')
    .description('print the merged configuration with secrets redacted')
    .option('--resolved', 'include resolved paths and layer provenance', false)
    .option('--json', 'emit JSON instead of YAML', false)
    .action((options: { resolved: boolean; json: boolean }) => {
      runConfigShow({
        config: configFrom(program),
        resolved: options.resolved,
        json: options.json,
      });
    });

  const importCmd = program.command('import').description('load seed data');
  importCmd
    .command('cities')
    .description('import cities from a spreadsheet or CSV')
    .argument('<file>', 'path to the .xlsx or .csv file')
    .option('-s, --sheet <name>', 'sheet name or 1-based index (default: first sheet)')
    .option('--dry-run', 'parse and report without writing', false)
    .option('--json', 'emit machine-readable output', false)
    .action(async (file: string, options: { sheet?: string; dryRun: boolean; json: boolean }) => {
      await runImportCities({
        config: configFrom(program),
        file,
        ...(options.sheet !== undefined && { sheet: sheetSelector(options.sheet) }),
        dryRun: options.dryRun,
        json: options.json,
      });
    });
  importCmd
    .command('categories')
    .description('import categories/services from a spreadsheet or CSV')
    .argument('<file>', 'path to the .xlsx or .csv file')
    .option('-s, --sheet <name>', 'sheet name or 1-based index (default: first sheet)')
    .option('--dry-run', 'parse and report without writing', false)
    .option('--json', 'emit machine-readable output', false)
    .action(async (file: string, options: { sheet?: string; dryRun: boolean; json: boolean }) => {
      await runImportCategories({
        config: configFrom(program),
        file,
        ...(options.sheet !== undefined && { sheet: sheetSelector(options.sheet) }),
        dryRun: options.dryRun,
        json: options.json,
      });
    });
  importCmd
    .command('sheets')
    .description('list the sheets in a workbook')
    .argument('<file>', 'path to the .xlsx file')
    .action(async (file: string) => {
      await runListSheets(file);
    });

  program
    .command('queue')
    .description('show or change which searches run first (spread across states by default)')
    .addOption(
      new Option(
        '--order <order>',
        'spread: round-robin across states; by-state: one at a time',
      ).choices(['spread', 'by-state']),
    )
    .option('--states <list>', 'comma-separated state codes to favour; "" clears them')
    .option('--only', 'search only --states; the rest wait as paused')
    .option('--all', 'search every state again (undoes --only)')
    .option('--json', 'emit machine-readable output', false)
    .action(
      (options: {
        order?: 'spread' | 'by-state';
        states?: string;
        only?: boolean;
        all?: boolean;
        json: boolean;
      }) => {
        runQueue({
          config: configFrom(program),
          ...(options.order !== undefined && { order: options.order }),
          ...(options.states !== undefined && { states: options.states }),
          ...(options.only === true && { only: true }),
          ...(options.all === true && { only: false }),
          json: options.json,
        });
      },
    );

  const seedsCmd = program
    .command('seeds')
    .description('the city and service lists committed in seeds/');
  seedsCmd
    .command('load')
    .description('add or update cities and services from seeds/ (never deletes)')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runSeedsLoad({ config: configFrom(program), json: options.json });
    });
  seedsCmd
    .command('save')
    .description("write the database's cities and services to seeds/, ready to commit")
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runSeedsSave({ config: configFrom(program), json: options.json });
    });

  program
    .command('plan')
    .description('create jobs from seed data (idempotent)')
    .option('-a, --automation <id>', 'automation id', 'google-maps')
    .option('--cities <list>', 'comma-separated city names, zips or state codes')
    .option('--categories <list>', 'comma-separated category names or slugs')
    .option('--limit <n>', 'cap the number of jobs, highest priority first', toInt)
    .option('--dry-run', 'report what would be created without writing', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      (options: {
        automation: string;
        cities?: string;
        categories?: string;
        limit?: number;
        dryRun: boolean;
        json: boolean;
      }) => {
        runPlan({
          config: configFrom(program),
          automationId: options.automation,
          ...(options.cities !== undefined && { cities: splitList(options.cities) }),
          ...(options.categories !== undefined && { categories: splitList(options.categories) }),
          ...(options.limit !== undefined && { limit: options.limit }),
          dryRun: options.dryRun,
          json: options.json,
        });
      },
    );

  program
    .command('run')
    .description('execute queued jobs')
    .option('-a, --automation <id>', 'automation id', 'google-maps')
    .option('-w, --workers <n>', 'concurrent browser workers', toInt)
    .option('-n, --max-jobs <n>', 'stop after this many jobs', toInt)
    .option('--headful', 'show the browser window', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: {
        automation: string;
        workers?: number;
        maxJobs?: number;
        headful: boolean;
        json: boolean;
      }) => {
        await runRun({
          config: configFrom(program),
          automationId: options.automation,
          ...(options.workers !== undefined && { workers: options.workers }),
          ...(options.maxJobs !== undefined && { maxJobs: options.maxJobs }),
          headful: options.headful,
          json: options.json,
        });
      },
    );

  const enrich = program.command('enrich').description('enrich scraped businesses');
  enrich
    .command('emails')
    .description('crawl business websites for contact addresses')
    .option('-w, --workers <n>', 'concurrent HTTP workers', toInt)
    .option('-n, --max-domains <n>', 'stop after this many domains', toInt)
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { workers?: number; maxDomains?: number; json: boolean }) => {
      await runEnrichEmails({
        config: configFrom(program),
        ...(options.workers !== undefined && { workers: options.workers }),
        ...(options.maxDomains !== undefined && { maxDomains: options.maxDomains }),
        json: options.json,
      });
    });

  program
    .command('qualify')
    .description("apply the campaign's rules: specialties, exclusions, leads ready to send")
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runQualify({ config: configFrom(program), json: options.json });
    });

  const suppress = program
    .command('suppress')
    .description('the opt-out list: who must never be contacted again');
  suppress
    .command('add')
    .description('opt out an email, phone number or website (several at once is fine)')
    .argument('<values...>', 'e.g. contact@monsalon.fr "06 12 34 56 78" monsalon.fr')
    .option('-r, --reason <text>', 'why, for the record')
    .option('--json', 'emit machine-readable output', false)
    .action((values: string[], options: { reason?: string; json: boolean }) => {
      runSuppressAdd({
        config: configFrom(program),
        values,
        ...(options.reason !== undefined && { reason: options.reason }),
        json: options.json,
      });
    });
  suppress
    .command('list')
    .description('show every opt-out, newest first')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runSuppressList({ config: configFrom(program), json: options.json });
    });
  suppress
    .command('remove')
    .description('undo an opt-out entered by mistake')
    .argument('<value>', 'the email, phone number or website')
    .action((value: string) => {
      runSuppressRemove({ config: configFrom(program), value });
    });

  program
    .command('status')
    .description('show queue progress, throughput and ETA')
    .option('-a, --automation <id>', 'restrict to one automation')
    .addOption(
      new Option('--by <grouping>', 'break progress down per group').choices([
        'city',
        'category',
        'state',
      ]),
    )
    .option('--incomplete', 'with --by, hide groups that have nothing left to run', false)
    .option('-n, --limit <n>', 'with --by, maximum groups to show', toInt)
    .option('--json', 'emit machine-readable output', false)
    .action(
      (options: {
        automation?: string;
        by?: GroupingName;
        incomplete: boolean;
        limit?: number;
        json: boolean;
      }) => {
        runStatus({
          config: configFrom(program),
          ...(options.automation !== undefined && { automationId: options.automation }),
          ...(options.by !== undefined && { by: options.by }),
          incompleteOnly: options.incomplete,
          ...(options.limit !== undefined && { limit: options.limit }),
          json: options.json,
        });
      },
    );

  const jobs = program.command('jobs').description('inspect and steer individual jobs');
  jobs
    .command('list')
    .description('list jobs')
    .option('-a, --automation <id>', 'restrict to one automation')
    .addOption(new Option('-s, --status <status>', 'filter by status').choices(JOB_STATUS_CHOICES))
    .option('--error-kind <kind>', 'filter by last error kind, e.g. lease_expired')
    .option('-n, --limit <n>', 'maximum rows', toInt, 50)
    .option('--json', 'emit machine-readable output', false)
    .action(
      (options: {
        automation?: string;
        status?: JobStatus;
        errorKind?: string;
        limit: number;
        json: boolean;
      }) => {
        runJobsList({
          config: configFrom(program),
          ...(options.automation !== undefined && { automationId: options.automation }),
          ...(options.status !== undefined && { status: options.status }),
          ...(options.errorKind !== undefined && { errorKind: options.errorKind }),
          limit: options.limit,
          json: options.json,
        });
      },
    );
  jobs
    .command('retry')
    .description('return failed or paused jobs to pending')
    .argument('[ids...]', 'specific job ids (default: all failed and paused)')
    .option('-a, --automation <id>', 'restrict to one automation')
    .addOption(
      new Option('-s, --status <status>', 'retry jobs in this status').choices(JOB_STATUS_CHOICES),
    )
    .action((ids: string[], options: { automation?: string; status?: JobStatus }) => {
      runJobsRetry({
        config: configFrom(program),
        ...(options.automation !== undefined && { automationId: options.automation }),
        ...(options.status !== undefined && { status: options.status }),
        ...(ids.length > 0 && { ids: ids.map((id) => Number.parseInt(id, 10)) }),
      });
    });

  program
    .command('ui')
    .description('open the local dashboard — run everything from a browser')
    .option('-p, --port <n>', 'port to listen on (default: ui.port, 4600)', toInt)
    .option('--no-open', 'do not open a browser window')
    // No `-c` short form: the program's own `-c, --config <path>` shadows it, so
    // `gms ui -c` fails asking for a config path and `gms ui -c x.yaml` starts a
    // view-only dashboard. Advertising a short flag that cannot work is worse
    // than having none.
    .option(
      '--control',
      'let the page start scrapes, imports and exports, and edit settings',
      false,
    )
    .option('--allow-config-write', 'edit settings only, without task controls', false)
    .action(
      async (options: {
        port?: number;
        open: boolean;
        control: boolean;
        allowConfigWrite: boolean;
      }) => {
        const globals = program.opts<GlobalOptions>();
        await runUi({
          config: configFrom(program),
          ...(options.port !== undefined && { port: options.port }),
          open: options.open,
          // --control implies settings editing: someone who can start a scrape
          // can already change how it runs.
          allowControl: options.control,
          allowConfigWrite: options.control || options.allowConfigWrite,
          ...(globals.config !== undefined && { configFile: globals.config }),
        });
      },
    );

  const exportCmd = program.command('export').description('write results out');
  exportCmd
    .command('csv')
    .description('export to CSV, resuming from the last position')
    .addOption(
      new Option('-e, --entity <name>', 'what to export')
        .choices([
          'leads-flat',
          'leads-with-email',
          'leads-by-business',
          'prospects',
          'businesses',
          'emails',
        ])
        .default('leads-flat'),
    )
    .option('-o, --out-dir <path>', 'output directory (default: dataDir/exports)')
    .option('--full', 're-export everything, ignoring the cursor', false)
    .option('--split-by <column>', 'one file per value, e.g. state')
    .option('--excel-safe', 'wrap zips/phones as ="01234" so Excel keeps leading zeros', false)
    .option('--no-bom', 'omit the UTF-8 byte-order mark')
    .option('--crlf', 'use Windows line endings', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      (
        options: {
          entity: string;
          outDir?: string;
          full: boolean;
          splitBy?: string;
          excelSafe: boolean;
          bom: boolean;
          crlf: boolean;
          json: boolean;
        },
        command: Command,
      ) => {
        // These two also exist in the config file, so the flag must only win
        // when it was actually typed. Commander gives both a value either way
        // (`--no-bom` in particular defaults `bom` to true), which is why the
        // source has to be asked for rather than inferred from the value.
        const typed = (name: string): boolean => command.getOptionValueSource(name) !== 'default';

        runExportCsv({
          config: configFrom(program),
          entity: options.entity,
          ...(options.outDir !== undefined && { outDir: options.outDir }),
          full: options.full,
          ...(options.splitBy !== undefined && { splitBy: options.splitBy }),
          ...(typed('excelSafe') && { excelSafe: options.excelSafe }),
          ...(typed('bom') && { bom: options.bom }),
          crlf: options.crlf,
          json: options.json,
        });
      },
    );
  exportCmd
    .command('sheets')
    .description('push results to a shared Google Sheet, resuming from the last position')
    .addOption(
      // No default here: without --entity, exporters.sheets.layout decides.
      new Option(
        '-e, --entity <name>',
        'what to export (default: exporters.sheets.layout)',
      ).choices([
        'leads-flat',
        'leads-with-email',
        'leads-by-business',
        'prospects',
        'businesses',
        'emails',
      ]),
    )
    .option('-s, --spreadsheet-id <id>', 'from the sheet URL (overrides config)')
    .option('-t, --tab <name>', 'sheet tab name')
    .option('--full', 're-send everything, ignoring the cursor', false)
    .option('--rebuild', 'clear the tab below its header, then send everything again', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: {
        entity?: string;
        rebuild: boolean;
        spreadsheetId?: string;
        tab?: string;
        full: boolean;
        json: boolean;
      }) => {
        await runExportSheets({
          config: configFrom(program),
          ...(options.entity !== undefined && { entity: options.entity }),
          ...(options.spreadsheetId !== undefined && { spreadsheetId: options.spreadsheetId }),
          ...(options.tab !== undefined && { sheetName: options.tab }),
          full: options.full,
          rebuild: options.rebuild,
          json: options.json,
        });
      },
    );
  exportCmd
    .command('status')
    .description('show how far each exporter has reached')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runExportStatus({ config: configFrom(program), json: options.json });
    });

  const db = program.command('db').description('database maintenance');
  db.command('migrate')
    .description('apply pending migrations')
    .option('--dry-run', 'show what would be applied without changing anything', false)
    .action((options: { dryRun: boolean }) => {
      runDbMigrate({ config: configFrom(program), dryRun: options.dryRun });
    });
  db.command('status')
    .description('show database and migration state')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      runDbStatus({ config: configFrom(program), json: options.json });
    });
  db.command('check')
    .description('run a full integrity check')
    .action(() => {
      if (!runDbCheck({ config: configFrom(program) })) process.exit(1);
    });
  db.command('vacuum')
    .description('compact the database and reclaim free pages')
    .action(() => {
      runDbVacuum({ config: configFrom(program) });
    });
  db.command('backup')
    .description('write a consistent copy (safe while the database is in use)')
    .argument('<destination>', 'path for the backup file')
    .action((destination: string) => {
      runDbBackup({ config: configFrom(program), destination });
    });

  return program;
}

async function main(): Promise<void> {
  // Started by the dashboard: let it ask for a graceful stop over IPC, which
  // works on Windows where SIGTERM cannot.
  listenForParentStop();
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    fail(error);
  }
}

/**
 * Whether this module is the process entry point.
 *
 * Resolving the symlink is essential, not defensive. An npm `bin` is installed
 * as a **symlink**, so when this runs as `gms` the entry is `.../bin/gms` while
 * `import.meta.url` is the real `.../dist/cli/main.js`. Comparing them
 * unresolved never matches, and the command silently does nothing — it exits 0
 * having printed not a word, which is the worst way for a CLI to fail.
 *
 * `pathToFileURL` handles Windows drive letters and spaces, which naive
 * `file://` concatenation does not.
 *
 * Exported so this can be tested without building and installing the package.
 */
export function isEntryPoint(
  entry: string | undefined,
  moduleUrl: string,
  resolve: (p: string) => string = realpathSync,
): boolean {
  if (entry === undefined || entry === '') return false;
  let resolved = entry;
  try {
    resolved = resolve(entry);
  } catch {
    // Not a real path (an `-e` eval, a virtual entry): compare what we got.
  }
  return pathToFileURL(resolved).href === moduleUrl;
}

// Run only when invoked directly, so tests can import buildProgram() without
// the CLI executing.
if (isEntryPoint(process.argv[1], import.meta.url)) {
  void main();
}
