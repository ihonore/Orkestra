/**
 * `gms config show` — print the merged, validated configuration.
 *
 * Secrets are redacted through the same path list the logger uses, so this
 * command can be pasted into a bug report safely.
 */
import { stringify as stringifyYaml } from 'yaml';
import { redactSecrets } from '../../config/redact.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { displayPath } from '../../core/util/paths.js';
import { heading, keyValue, style } from '../output.js';

export interface ConfigShowOptions {
  readonly config: ResolvedConfig;
  /** Include resolved absolute paths and layer provenance. */
  readonly resolved: boolean;
  readonly json: boolean;
}

export function runConfigShow(options: ConfigShowOptions): void {
  const { config } = options;
  const { paths, hash, sources, ...settings } = config;
  const safeSettings = redactSecrets(settings);

  if (options.json) {
    const payload = options.resolved
      ? { ...safeSettings, paths, hash, sources }
      : { ...safeSettings };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(stringifyYaml(safeSettings, { indent: 2 }).trimEnd());

  if (!options.resolved) return;

  console.log(heading('Resolved paths'));
  console.log(
    keyValue([
      ['root', displayPath(paths.root)],
      ['dataDir', displayPath(paths.dataDir)],
      ['database', displayPath(paths.databaseFile)],
      ['seeds', displayPath(paths.seedsDir)],
      ['logs', displayPath(paths.logsDir)],
      ['artifacts', displayPath(paths.artifactsDir)],
      ['exports', displayPath(paths.exportsDir)],
    ]),
  );

  console.log(heading('Layers'));
  console.log(keyValue(sources.map((source) => [source.kind, source.detail] as const)));
  console.log(`\n${style.grey(`config hash: ${hash}`)}`);
}
