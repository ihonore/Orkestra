/**
 * Job planning.
 *
 * Turns seed data into the queue: for Google Maps, the cross product of selected
 * cities and categories. Planning is separate from running so the work is
 * inspectable before a browser ever opens, and so `plan` can be re-run safely
 * after adding cities without disturbing progress on existing jobs.
 */
import type { CategoryRecord, CityRecord } from '../../db/repositories/seeds.js';
import type { JobSpec } from '../../db/repositories/jobs.js';

/** Parameters stored on a Google Maps job. Enough to run it without re-reading seeds. */
export interface GoogleMapsJobParams {
  readonly cityId: number;
  readonly categoryId: number;
  readonly city: string;
  readonly stateCode: string;
  readonly zip: string;
  readonly lat: number;
  readonly lng: number;
  readonly category: string;
  readonly categorySlug: string;
}

export interface PlanOptions {
  readonly automationId?: string;
  /** Weight applied to city population when computing priority. */
  readonly populationWeight?: number;
  /** Cap on the number of jobs produced. Highest priority first. */
  readonly limit?: number;
}

/**
 * The stable identity of a (city, category) unit of work.
 *
 * Built from database ids rather than names so that renaming a city in the seed
 * sheet does not orphan its completed jobs and silently re-run them.
 */
export function taskKeyFor(cityId: number, categoryId: number): string {
  return `city:${cityId}|cat:${categoryId}`;
}

/**
 * Priority for a (city, category) pair — higher runs first.
 *
 * A full sweep is a 1–2 week job, so the ordering decides which leads exist on
 * day one. Population dominates (a Houston plumber list is worth more than a
 * Cheyenne one) with category weight as the tie-breaker.
 *
 * Population is log-scaled: without it, the largest city would outrank the next
 * hundred combined and category weight would never matter.
 */
export function priorityFor(
  city: CityRecord,
  category: CategoryRecord,
  populationWeight = 1,
): number {
  const population = city.population ?? 0;
  const populationScore = population > 0 ? Math.log10(population) * 10 * populationWeight : 0;
  const categoryScore = category.weight * 10;
  return Math.round(populationScore + categoryScore);
}

/**
 * Build the job specs for a set of cities and categories.
 *
 * Pure: it does not touch the database. The caller enqueues the result, which
 * is idempotent on `taskKey`, so re-planning never duplicates work.
 */
export function planGoogleMapsJobs(
  cities: readonly CityRecord[],
  categories: readonly CategoryRecord[],
  options: PlanOptions = {},
): JobSpec[] {
  const automationId = options.automationId ?? 'google-maps';
  const specs: JobSpec[] = [];

  for (const city of cities) {
    for (const category of categories) {
      const params: GoogleMapsJobParams = {
        cityId: city.id,
        categoryId: category.id,
        city: city.city,
        stateCode: city.state_code,
        zip: city.zip,
        lat: city.lat,
        lng: city.lng,
        category: category.name,
        categorySlug: category.slug,
      };
      specs.push({
        automationId,
        taskKey: taskKeyFor(city.id, category.id),
        params,
        priority: priorityFor(city, category, options.populationWeight),
      });
    }
  }

  specs.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return options.limit !== undefined ? specs.slice(0, options.limit) : specs;
}
