/**
 * `gms suppress` — the opt-out list.
 *
 * Anyone who asks not to be contacted again goes here, and every export
 * leaves them out from then on — French law (and CAN-SPAM in the US) requires
 * an opt-out to be honoured. An email, a phone number or a website: whatever
 * the team has.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { EmailsRepository } from '../../db/repositories/emails.js';
import { parseOptOut } from '../../qualify/opt-out.js';
import { AppError } from '../../core/errors/taxonomy.js';
import { style, symbol } from '../output.js';

export interface SuppressOptions {
  readonly config: ResolvedConfig;
  readonly json?: boolean;
}

function parseOrFail(value: string, config: ResolvedConfig) {
  const optOut = parseOptOut(value, config.market.country);
  if (optOut === null) {
    throw new AppError(`"${value}" is not an email, phone number or website.`, {
      code: 'CONFIG_INVALID',
      hint: 'For example: contact@monsalon.fr, 06 12 34 56 78, or monsalon.fr',
    });
  }
  return optOut;
}

export function runSuppressAdd(
  options: SuppressOptions & { readonly values: readonly string[]; readonly reason?: string },
): void {
  const optOuts = options.values.map((v) => parseOrFail(v, options.config));
  const driver = openDatabaseFromConfig(options.config);
  try {
    const emails = new EmailsRepository(driver);
    for (const o of optOuts) emails.addSuppression(o.kind, o.value, options.reason ?? null);
    if (options.json === true) {
      console.log(JSON.stringify(optOuts, null, 2));
      return;
    }
    for (const o of optOuts) console.log(`${symbol.ok} ${o.kind} ${o.value}`);
    console.log(style.grey('\nLeft out of every export from now on.'));
  } finally {
    driver.close();
  }
}

export function runSuppressRemove(options: SuppressOptions & { readonly value: string }): void {
  const o = parseOrFail(options.value, options.config);
  const driver = openDatabaseFromConfig(options.config);
  try {
    const removed = new EmailsRepository(driver).removeSuppression(o.kind, o.value);
    console.log(
      removed
        ? `${symbol.ok} removed ${o.kind} ${o.value}`
        : `${symbol.warn} ${o.value} was not on the list`,
    );
  } finally {
    driver.close();
  }
}

export function runSuppressList(options: SuppressOptions): void {
  const driver = openDatabaseFromConfig(options.config, { readonly: true });
  try {
    const rows = new EmailsRepository(driver).listSuppressions();
    if (options.json === true) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('No opt-outs yet.');
      return;
    }
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString().slice(0, 10);
      console.log(
        `  ${when}  ${r.kind.padEnd(6)}  ${r.value}${r.reason !== null ? style.grey(`  ${r.reason}`) : ''}`,
      );
    }
  } finally {
    driver.close();
  }
}
