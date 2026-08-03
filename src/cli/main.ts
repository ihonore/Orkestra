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
import { Command, Option } from 'commander';
import { loadConfig } from '../config/loader.js';
import type { LogLevel, ResolvedConfig } from '../config/schema.js';
import { errorMessage, isAppError } from '../core/errors/taxonomy.js';
import { APP_VERSION } from '../version.js';
import { runConfigShow } from './commands/config.js';
import { runDbBackup, runDbCheck, runDbMigrate, runDbStatus, runDbVacuum } from './commands/db.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { style, symbol } from './output.js';

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
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      const { failed } = runDoctor({ config: configFrom(program), json: options.json });
      if (failed) process.exit(1);
    });

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
