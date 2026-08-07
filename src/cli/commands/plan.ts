/**
 * `gms plan` — materialize jobs from seed data.
 *
 * Creating 15,725 rows costs nothing and starts nothing. Planning is separate
 * from running precisely so the work can be inspected, filtered and prioritized
 * before a browser opens.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { AppError } from '../../core/errors/taxonomy.js';
import { planGoogleMapsJobs } from '../../core/engine/planner.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import { JobsRepository } from '../../db/repositories/jobs.js';
import { CategoriesRepository, CitiesRepository } from '../../db/repositories/seeds.js';
import { heading, keyValue, style, symbol } from '../output.js';

export interface PlanCommandOptions {
  readonly config: ResolvedConfig;
  readonly automationId?: string;
  readonly cities?: readonly string[];
  readonly categories?: readonly string[];
  readonly limit?: number;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export function runPlan(options: PlanCommandOptions): void {
  const automationId = options.automationId ?? 'google-maps';
  const driver = openDatabaseFromConfig(options.config);

  try {
    const cities = new CitiesRepository(driver).findBySelectors(options.cities ?? []);
    const categories = new CategoriesRepository(driver).findBySelectors(options.categories ?? []);

    if (cities.length === 0 || categories.length === 0) {
      const what = cities.length === 0 ? 'cities' : 'categories';
      const selectors = cities.length === 0 ? options.cities : options.categories;
      throw new AppError(
        selectors && selectors.length > 0
          ? `No ${what} matched ${selectors.join(', ')}.`
          : `No ${what} in the database.`,
        {
          code: selectors && selectors.length > 0 ? 'PLAN_NO_MATCH' : 'PLAN_NO_SEEDS',
          hint:
            selectors && selectors.length > 0
              ? `Cities match on name, zip or state code; categories on name or slug.`
              : `Import seed data first:\n  gms import ${what} <file.xlsx> --sheet ${what === 'cities' ? 'Cities' : 'Services'}`,
        },
      );
    }

    const specs = planGoogleMapsJobs(cities, categories, {
      automationId,
      ...(options.limit !== undefined && { limit: options.limit }),
    });

    const jobs = new JobsRepository(driver);
    const before = jobs.counts(automationId);

    if (options.dryRun === true) {
      if (options.json === true) {
        console.log(
          JSON.stringify(
            {
              cities: cities.length,
              categories: categories.length,
              wouldPlan: specs.length,
              existing: before,
              applied: false,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        keyValue([
          ['automation', automationId],
          ['cities', String(cities.length)],
          ['categories', String(categories.length)],
          ['would plan', specs.length.toLocaleString()],
        ]),
      );
      console.log(`\n${style.grey('Dry run — no jobs were created.')}`);
      return;
    }

    const result = jobs.enqueue(specs);
    const after = jobs.counts(automationId);

    if (options.json === true) {
      console.log(
        JSON.stringify(
          {
            cities: cities.length,
            categories: categories.length,
            planned: specs.length,
            created: result.inserted,
            alreadyExisted: result.skipped,
            counts: after,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      keyValue([
        ['automation', automationId],
        ['cities', cities.length.toLocaleString()],
        ['categories', categories.length.toLocaleString()],
        ['planned', specs.length.toLocaleString()],
        ['created', result.inserted.toLocaleString()],
        ['already existed', result.skipped.toLocaleString()],
      ]),
    );

    console.log(heading('Queue'));
    console.log(
      keyValue(
        Object.entries(after)
          .filter(([, n]) => n > 0)
          .map(([status, n]) => [status, n.toLocaleString()] as const),
      ),
    );

    console.log(
      `\n${symbol.ok} ${result.inserted === 0 ? 'queue already up to date' : `${result.inserted.toLocaleString()} job(s) created`}`,
    );
    if (result.inserted > 0) {
      console.log(style.grey('\nNext:\n  gms status        # inspect the queue'));
    }
  } finally {
    driver.close();
  }
}
