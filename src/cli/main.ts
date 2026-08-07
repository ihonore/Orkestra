#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Commands are thin: they parse flags, load config once, call into the library,
 * and format the result. All behaviour lives under `src/core`, `src/db` and
 * `src/config` so the forthcoming HTTP API can expose the same operations
 * without going through argv.
 */
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadConfig } from '../config/loader.js';
import type { LogLevel, ResolvedConfig } from '../config/schema.js';
import { errorMessage, isAppError } from '../core/errors/taxonomy.js';
import { APP_VERSION } from '../version.js';
import { runConfigShow } from './commands/config.js';
import { runDbBackup, runDbCheck, runDbMigrate, runDbStatus, runDbVacuum } from './commands/db.js';
import { runDoctor } from './commands/doctor.js';
import { runImportCategories, runImportCities, runListSheets } from './commands/import.js';
import { runInit } from './commands/init.js';
import { runPlan } from './commands/plan.js';
import { runRun } from './commands/run.js';
import { runJobsList, runJobsRetry, runStatus } from './commands/status.js';
import { style, symbol } from './output.js';
import type { JobStatus } from '../db/repositories/jobs.js';
import type { GroupingName } from '../db/repositories/progress.js';

interface GlobalOptions {
  readonly config?: string;
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
    overrides,
  });
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
    .option('--all', 'run every check, including the slow ones', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: { proxies: boolean; browser: boolean; all: boolean; json: boolean }) => {
        const { failed } = await runDoctor({
          config: configFrom(program),
          json: options.json,
          proxies: options.proxies || options.all,
          browser: options.browser || options.all,
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
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    fail(error);
  }
}

// Run only when invoked directly, so tests can import buildProgram() without
// the CLI executing. pathToFileURL handles Windows drive letters and spaces,
// which naive `file://` concatenation does not.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  void main();
}
