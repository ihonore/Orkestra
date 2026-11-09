/**
 * `gms qualify` — apply the campaign's rules and say what they did.
 *
 * The same pass runs by itself before every email crawl and export; this
 * command is for seeing the result: how many leads are wanted, why the rest
 * are not, and which Google categories the category map does not cover yet.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { qualifyCampaign, rulesFromConfig } from '../../qualify/pass.js';
import { heading, keyValue, style, symbol } from '../output.js';

export interface QualifyCommandOptions {
  readonly config: ResolvedConfig;
  readonly json?: boolean;
}

export function runQualify(options: QualifyCommandOptions): void {
  const { config } = options;
  if (!config.qualify.enabled) {
    console.log(
      `${symbol.warn} qualify is off for this project — every business is exported as found.`,
    );
    console.log(style.grey('Turn it on with qualify.enabled in the campaign config.'));
    return;
  }

  // Read before opening the database, so a broken rules file says so plainly.
  rulesFromConfig(config);
  const driver = openDatabaseFromConfig(config);
  try {
    const report = qualifyCampaign(driver, config);
    if (options.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      keyValue([
        ['businesses', String(report.businesses)],
        ['wanted', String(report.wanted)],
        ['excluded', String(report.excluded)],
        ['ready to send', `${report.newlyReady} new`],
        ['waiting for their website', String(report.waitingForEmails)],
        ...(report.sitesRetired > 0
          ? ([['sites not crawled', `${report.sitesRetired} (all unwanted)`]] as [string, string][])
          : []),
        ...(report.sitesRestored > 0
          ? ([['sites back in the queue', String(report.sitesRestored)]] as [string, string][])
          : []),
        ...(report.relinked.moved > 0 || report.relinked.notWebsites > 0
          ? ([
              [
                'websites refiled',
                `${report.relinked.moved} moved, ${report.relinked.notWebsites} not a website, ` +
                  `${report.relinked.linksDropped} email links dropped`,
              ],
            ] as [string, string][])
          : []),
      ]),
    );

    if (report.reasons.length > 0) {
      console.log(heading('Why businesses were left out'));
      for (const { reason, count } of report.reasons) {
        console.log(`  ${String(count).padStart(5)}  ${reason}`);
      }
    }
    if (report.unmapped.length > 0) {
      console.log(heading('Google categories not in the category map'));
      for (const { category, count } of report.unmapped.slice(0, 25)) {
        console.log(`  ${String(count).padStart(5)}  ${category}`);
      }
      console.log(
        style.grey(
          '\nAdd them to the categories file with a label and specialty, or a reason to exclude them.',
        ),
      );
    }
  } finally {
    driver.close();
  }
}
