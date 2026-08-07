/**
 * Read models for the dashboard.
 *
 * Plain functions over the repositories, returning JSON-ready shapes. The UI is
 * a client of the same layer the CLI uses — no privileged path, which is what
 * keeps a future HTTP API from needing a second implementation.
 */
import type { ResolvedConfig } from '../config/schema.js';
import { redactSecrets } from '../config/redact.js';
import type { SqliteDriver } from '../db/driver/types.js';
import { JobsRepository } from '../db/repositories/jobs.js';
import { EmailsRepository } from '../db/repositories/emails.js';
import { ExportsRepository } from '../db/repositories/exports.js';
import { GROUPINGS, ProgressRepository } from '../db/repositories/progress.js';
import { CategoriesRepository, CitiesRepository } from '../db/repositories/seeds.js';

export interface Overview {
  readonly jobs: Record<string, number>;
  readonly jobsTotal: number;
  readonly seeds: { cities: number; categories: number };
  readonly businesses: number;
  readonly withPhone: number;
  readonly withWebsite: number;
  readonly withEmail: number;
  readonly emails: { usable: number; personal: number; role: number };
  readonly domains: Record<string, number>;
  readonly throughputPerHour: number;
  readonly etaMs: number | null;
  readonly lastActivityAt: number | null;
}

export function overview(driver: SqliteDriver): Overview {
  const jobs = new JobsRepository(driver).counts('google-maps');
  const jobsTotal = Object.values(jobs).reduce((a, b) => a + b, 0);

  const b = driver
    .prepare<{ total: number; phone: number; website: number; withEmail: number }>(
      `SELECT COUNT(*) AS total,
              COUNT(phone_e164) AS phone,
              COUNT(website_url) AS website,
              (SELECT COUNT(DISTINCT be.business_id)
                 FROM business_emails be
                 JOIN emails e ON e.id = be.email_id
                WHERE e.is_junk = 0) AS withEmail
         FROM businesses`,
    )
    .get() ?? { total: 0, phone: 0, website: 0, withEmail: 0 };

  const emailStats = new EmailsRepository(driver).stats();

  const domains = Object.fromEntries(
    driver
      .prepare<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM domains GROUP BY status`,
      )
      .all()
      .map((row) => [row.status, row.n]),
  );

  // Throughput from the last hour only — early jobs run at a different rate
  // than a warm run, so a lifetime average would give a misleading ETA.
  const hourAgo = Date.now() - 3_600_000;
  const recent =
    driver
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs WHERE finished_at IS NOT NULL AND finished_at > ?`,
      )
      .get([hourAgo])?.n ?? 0;

  const remaining = jobs.pending + jobs.leased;

  return {
    jobs,
    jobsTotal,
    seeds: {
      cities: new CitiesRepository(driver).count(),
      categories: new CategoriesRepository(driver).count(),
    },
    businesses: b.total,
    withPhone: b.phone,
    withWebsite: b.website,
    withEmail: b.withEmail,
    emails: {
      usable: emailStats['emails_usable'] ?? 0,
      personal: emailStats['emails_personal'] ?? 0,
      role: (emailStats['emails_usable'] ?? 0) - (emailStats['emails_personal'] ?? 0),
    },
    domains,
    throughputPerHour: recent,
    etaMs: recent > 0 ? (remaining / recent) * 3_600_000 : null,
    lastActivityAt:
      driver.prepare<{ t: number | null }>(`SELECT MAX(finished_at) AS t FROM jobs`).get()?.t ??
      null,
  };
}

/** Per-group progress, for the sweep plate. */
export function progress(driver: SqliteDriver, by: 'city' | 'category' | 'state') {
  const grouping = GROUPINGS[by];
  return new ProgressRepository(driver).groups({
    automationId: 'google-maps',
    idPath: grouping.idPath,
    labelPath: grouping.labelPath,
    ...('sublabelPath' in grouping && { sublabelPath: grouping.sublabelPath }),
    limit: 1_000,
  });
}

export interface LeadQuery {
  readonly search?: string;
  readonly state?: string;
  readonly hasEmail?: boolean;
  readonly hasPhone?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface LeadRow {
  readonly id: number;
  readonly name: string;
  readonly category: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly email_type: string | null;
  readonly website: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly rating: number | null;
  readonly gmaps_url: string | null;
}

/**
 * Search leads.
 *
 * Filters are bound parameters, never interpolated — this endpoint takes user
 * text and is the one place a string could reach SQL.
 */
export function leads(driver: SqliteDriver, query: LeadQuery): { rows: LeadRow[]; total: number } {
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (query.search !== undefined && query.search.trim() !== '') {
    where.push(`(b.name LIKE :q OR b.city LIKE :q OR e.address LIKE :q OR b.website_url LIKE :q)`);
    params['q'] = `%${query.search.trim()}%`;
  }
  if (query.state !== undefined && query.state !== '') {
    where.push('b.state_code = :state');
    params['state'] = query.state;
  }
  if (query.hasEmail === true) where.push('e.address IS NOT NULL');
  if (query.hasPhone === true) where.push('b.phone_e164 IS NOT NULL');

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM businesses b
    LEFT JOIN business_emails be ON be.business_id = b.id
    LEFT JOIN emails e ON e.id = be.email_id AND e.is_junk = 0`;

  const total =
    driver.prepare<{ n: number }>(`SELECT COUNT(*) AS n ${from} ${clause}`).get(params)?.n ?? 0;

  const rows = driver
    .prepare<LeadRow>(
      `SELECT b.id AS id, b.name AS name, b.category_primary AS category,
              b.phone_e164 AS phone, e.address AS email,
              CASE WHEN e.address IS NULL THEN NULL
                   WHEN e.is_role = 1 THEN 'role'
                   WHEN e.is_free = 1 THEN 'free'
                   ELSE 'personal' END AS email_type,
              b.website_url AS website, b.city AS city, b.state_code AS state,
              b.rating AS rating, b.gmaps_url AS gmaps_url
       ${from} ${clause}
       ORDER BY b.rating DESC NULLS LAST, b.id
       LIMIT :limit OFFSET :offset`,
    )
    .all({ ...params, limit: query.limit ?? 100, offset: query.offset ?? 0 });

  return { rows, total };
}

/** Recently failed jobs, so a problem is visible without leaving the page. */
export function failures(driver: SqliteDriver, limit = 20) {
  return driver
    .prepare<{
      id: number;
      task_key: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      last_error_kind: string | null;
      params_json: string;
    }>(
      `SELECT id, task_key, attempts, max_attempts, last_error, last_error_kind, params_json
         FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all([limit]);
}

/** States present in the data, for the filter control. */
export function states(driver: SqliteDriver): string[] {
  return driver
    .prepare<{ state_code: string }>(
      `SELECT DISTINCT state_code FROM businesses WHERE state_code IS NOT NULL ORDER BY state_code`,
    )
    .all()
    .map((r) => r.state_code);
}

export function exportCursors(driver: SqliteDriver) {
  return new ExportsRepository(driver).all();
}

/** The effective config, with secrets removed. */
export function configView(config: ResolvedConfig): unknown {
  const { paths, hash, sources, ...rest } = config;
  return {
    config: redactSecrets(rest as Record<string, unknown>),
    paths,
    hash,
    sources,
  };
}
