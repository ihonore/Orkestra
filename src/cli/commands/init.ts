/**
 * `gms init` — scaffold a config file and the runtime data directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { displayPath } from '../../core/util/paths.js';
import { style, symbol } from '../output.js';
import { CONFIG_TEMPLATE, GITIGNORE_ENTRIES } from '../template.js';

export interface InitOptions {
  readonly cwd: string;
  readonly force: boolean;
}

export interface InitResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

/** Append any missing gms entries to an existing .gitignore. Never rewrites it. */
function ensureGitignore(cwd: string): 'created' | 'updated' | 'unchanged' {
  const gitignorePath = path.join(cwd, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${GITIGNORE_ENTRIES.join('\n')}\n`, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const existingLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter(
    (entry) => !entry.startsWith('#') && !existingLines.has(entry),
  );
  if (missing.length === 0) return 'unchanged';

  const separator = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(gitignorePath, `${separator}\n# gms runtime state\n${missing.join('\n')}\n`);
  return 'updated';
}

export function runInit(options: InitOptions): InitResult {
  const created: string[] = [];
  const skipped: string[] = [];

  const configPath = path.join(options.cwd, 'gms.config.yaml');
  if (fs.existsSync(configPath) && !options.force) {
    skipped.push(configPath);
    console.log(
      `${symbol.warn} ${displayPath(configPath)} already exists ${style.grey('(use --force to overwrite)')}`,
    );
  } else {
    fs.writeFileSync(configPath, CONFIG_TEMPLATE, 'utf8');
    created.push(configPath);
    console.log(`${symbol.ok} wrote ${displayPath(configPath)}`);
  }

  // Create the data tree eagerly so a first run never races on mkdir, and so
  // permission problems surface here rather than mid-scrape.
  const dataDir = path.join(options.cwd, 'data');
  for (const sub of ['', 'logs', 'artifacts', 'exports']) {
    const dir = sub === '' ? dataDir : path.join(dataDir, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  console.log(`${symbol.ok} data directory ready at ${displayPath(dataDir)}`);

  const gitignore = ensureGitignore(options.cwd);
  if (gitignore !== 'unchanged') {
    console.log(`${symbol.ok} ${gitignore} .gitignore`);
  }

  console.log(`\n${style.bold('Next:')}`);
  console.log(`  gms db migrate    ${style.grey('# create the database')}`);
  console.log(`  gms doctor        ${style.grey('# verify the environment')}`);

  return { created, skipped };
}
