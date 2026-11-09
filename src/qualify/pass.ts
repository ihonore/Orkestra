/**
 * Apply a campaign's rules to every stored business.
 *
 * Idempotent and cheap (one read, one write per changed row), so it runs at
 * the start of every email crawl and every export rather than being something
 * to remember. Rules edited, a city switched on: the next pass reflects it.
 *
 * Three things happen, in order:
 *
 *  1. Each business gets its specialty, its category label and, when the
 *     campaign does not want it, the reason.
 *  2. A website whose businesses are all unwanted leaves the crawl queue —
 *     crawling a chain's site for email is wasted requests — and comes back
 *     if one of them becomes wanted again.
 *  3. A business that is wanted and whose email search is over (its site was
 *     crawled, or it has none worth crawling) gets the next `lead_seq`. That
 *     number only grows, so an export can send each lead exactly once, in the
 *     order they became ready — including those with no email at all.
 */
import { domainOf } from '../automations/google-maps/normalize.js';
import type { ResolvedConfig } from '../config/schema.js';
import { resolvePath } from '../core/util/paths.js';
import type { SqliteDriver } from '../db/driver/types.js';
import { relinkWebsites, type RelinkReport } from './relink.js';
import { fold, loadRules, qualify, type QualifyRules } from './rules.js';

export interface QualifyReport {
  readonly businesses: number;
  readonly wanted: number;
  readonly excluded: number;
  /** Exclusion reasons, most frequent first. */
  readonly reasons: readonly { readonly reason: string; readonly count: number }[];
  /** Google categories the category map does not cover yet. */
  readonly unmapped: readonly { readonly category: string; readonly count: number }[];
  readonly newlyReady: number;
  readonly waitingForEmails: number;
  readonly sitesRetired: number;
  readonly sitesRestored: number;
}

/** The campaign's rules, with file paths resolved against its config. */
export function rulesFromConfig(config: ResolvedConfig): QualifyRules {
  const q = config.qualify;
  const file = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : resolvePath(value, config.paths.root);
  return loadRules({
    categoriesFile: file(q.categoriesFile),
    exclusionsFile: file(q.exclusionsFile),
    chainSiteThreshold: q.chainSiteThreshold,
    activeAreasOnly: q.activeAreasOnly,
  });
}

interface Row {
  id: number;
  name: string;
  category_primary: string | null;
  state_code: string | null;
  permanently_closed: number;
  specialty: string | null;
  category_label: string | null;
  exclusion_reason: string | null;
  lead_seq: number | null;
  domain: string | null;
  is_social: number | null;
  domain_status: string | null;
  site_listings: number;
  search_specialty: string | null;
}

/** Website states after which a business's email search is over. */
const SEARCH_OVER = new Set(['done', 'failed', 'parked', 'skipped']);

export function runQualification(driver: SqliteDriver, rules: QualifyRules): QualifyReport {
  return driver.transaction(() => {
    const activeRegions = new Set(
      driver
        .prepare<{ state_code: string }>(`SELECT DISTINCT state_code FROM cities WHERE active = 1`)
        .all()
        .map((r) => r.state_code),
    );

    const rows = driver
      .prepare<Row>(
        `SELECT b.id, b.name, b.category_primary, b.state_code, b.permanently_closed,
                b.specialty, b.category_label, b.exclusion_reason, b.lead_seq,
                d.domain, d.is_social, d.status AS domain_status,
                CASE WHEN d.id IS NULL OR d.is_social = 1 THEN 0
                     ELSE (SELECT COUNT(*) FROM businesses o WHERE o.domain_id = d.id) END
                  AS site_listings,
                (SELECT c.specialty FROM business_sightings s
                   JOIN categories c ON c.id = s.seed_category_id
                  WHERE s.business_id = b.id ORDER BY s.id LIMIT 1) AS search_specialty
           FROM businesses b
           LEFT JOIN domains d ON d.id = b.domain_id
          ORDER BY b.id`,
      )
      .all();

    const update = driver.prepare(
      `UPDATE businesses
          SET specialty = :specialty, category_label = :categoryLabel,
              exclusion_reason = :exclusionReason
        WHERE id = :id`,
    );

    const reasons = new Map<string, number>();
    const unmapped = new Map<string, number>();
    let excluded = 0;

    for (const row of rows) {
      const result = qualify(
        {
          name: row.name,
          category: row.category_primary,
          region: row.state_code,
          permanentlyClosed: row.permanently_closed === 1,
          searchSpecialty: row.search_specialty,
          siteDomain: row.is_social === 0 ? row.domain : null,
          siteListings: row.site_listings,
        },
        rules,
        activeRegions,
      );
      if (
        result.specialty !== row.specialty ||
        result.categoryLabel !== row.category_label ||
        result.exclusionReason !== row.exclusion_reason
      ) {
        update.run({ id: row.id, ...result });
      }
      if (result.exclusionReason !== null) {
        excluded += 1;
        // Group "Hors zone (93)" and "Hors zone (94)" under one heading.
        const heading = result.exclusionReason.replace(/\s*\(.*\)$/, '');
        reasons.set(heading, (reasons.get(heading) ?? 0) + 1);
      }
      const category = row.category_primary;
      if (category !== null && !rules.categories.has(fold(category)) && rules.categories.size > 0) {
        unmapped.set(category, (unmapped.get(category) ?? 0) + 1);
      }
    }

    // A site only unwanted businesses use leaves the crawl queue; it comes
    // back when one of them is wanted again. Marked by its error so a site
    // skipped for another reason (a social profile) is never revived.
    const sitesRetired = driver
      .prepare(
        `UPDATE domains SET status = 'skipped', error = 'excluded'
          WHERE status = 'pending' AND is_social = 0
            AND EXISTS (SELECT 1 FROM businesses b WHERE b.domain_id = domains.id)
            AND NOT EXISTS (SELECT 1 FROM businesses b
                             WHERE b.domain_id = domains.id AND b.exclusion_reason IS NULL)`,
      )
      .run().changes;
    const sitesRestored = driver
      .prepare(
        `UPDATE domains SET status = 'pending', error = NULL
          WHERE status = 'skipped' AND error = 'excluded'
            AND EXISTS (SELECT 1 FROM businesses b
                         WHERE b.domain_id = domains.id AND b.exclusion_reason IS NULL)`,
      )
      .run().changes;

    // Ready leads, oldest first, numbered on from the last one handed out.
    const ready = driver
      .prepare<{ id: number; domain_status: string | null; is_social: number | null }>(
        `SELECT b.id, d.status AS domain_status, d.is_social
           FROM businesses b
           LEFT JOIN domains d ON d.id = b.domain_id
          WHERE b.exclusion_reason IS NULL AND b.lead_seq IS NULL
          ORDER BY b.id`,
      )
      .all();
    let next =
      (driver.prepare<{ n: number | null }>(`SELECT MAX(lead_seq) AS n FROM businesses`).get()?.n ??
        0) + 1;
    const number = driver.prepare(`UPDATE businesses SET lead_seq = :seq WHERE id = :id`);
    let newlyReady = 0;
    let waitingForEmails = 0;
    for (const row of ready) {
      const over =
        row.domain_status === null || row.is_social === 1 || SEARCH_OVER.has(row.domain_status);
      if (!over) {
        waitingForEmails += 1;
        continue;
      }
      number.run({ seq: next, id: row.id });
      next += 1;
      newlyReady += 1;
    }

    return {
      businesses: rows.length,
      wanted: rows.length - excluded,
      excluded,
      reasons: [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      unmapped: [...unmapped]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      newlyReady,
      waitingForEmails,
      sitesRetired,
      sitesRestored,
    };
  }, 'immediate');
}

export interface CampaignQualifyReport extends QualifyReport {
  readonly relinked: RelinkReport;
}

/**
 * The full pass for a campaign: websites filed under today's rules first
 * (see `relink.ts`), so the chain check and the crawl queue see them right,
 * then the qualification.
 */
export function qualifyCampaign(
  driver: SqliteDriver,
  config: ResolvedConfig,
): CampaignQualifyReport {
  const rules = rulesFromConfig(config);
  const relinked = relinkWebsites(driver, domainOf);
  return { ...runQualification(driver, rules), relinked };
}

/**
 * Qualify when the campaign asks for it, and say so; do nothing otherwise.
 * Called at the start of every email crawl and export.
 */
export function qualifyIfEnabled(
  driver: SqliteDriver,
  config: ResolvedConfig,
): CampaignQualifyReport | null {
  if (!config.qualify.enabled) return null;
  return qualifyCampaign(driver, config);
}
