/**
 * Editing cities and services, with the queue kept in step.
 *
 * Every operation here changes two things in one transaction: the seed row and
 * the jobs planned from it. Changing only the seed is the easy mistake — a
 * paused city whose 85 searches are still claimable is not paused, and a
 * corrected zip that never reaches the queued jobs searches the old place.
 *
 * The rule the queue follows, once `plan` has run at least once:
 *
 *   every active city x every active service has a job, and only those jobs
 *   can be claimed.
 *
 * Adding or resuming a seed creates its missing jobs; pausing one parks its
 * queued jobs as `paused`. Before the first `plan` nothing is queued, so an
 * edit touches seeds only — creating 85 jobs for one city would make step 2
 * look done when nothing else was planned.
 */
import { SeedError } from '../core/errors/taxonomy.js';
import { planGoogleMapsJobs } from '../core/engine/planner.js';
import type { SqliteDriver } from '../db/driver/types.js';
import { JobsRepository } from '../db/repositories/jobs.js';
import {
  SeedJobsRepository,
  type SeedJobCounts,
  type SeedKind,
} from '../db/repositories/seed-jobs.js';
import {
  CategoriesRepository,
  CitiesRepository,
  type CategoryInput,
  type CategoryRecord,
  type CityInput,
  type CityRecord,
} from '../db/repositories/seeds.js';
import {
  cleanNumber,
  cleanText,
  isValidLatitude,
  isValidLongitude,
  normalizeStateCode,
  normalizeZip,
  slugify,
} from '../importers/normalize.js';
import { syncQueue } from './queue.js';

const AUTOMATION_ID = 'google-maps';

/** What the dashboard sends: untyped form values. */
export type SeedForm = Readonly<Record<string, unknown>>;

/** Postal code to name, so a form needs only the two letters. */
// prettier-ignore
const STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

function invalid(message: string, hint?: string): SeedError {
  return new SeedError(message, { code: 'SEED_INVALID', ...(hint !== undefined && { hint }) });
}

/**
 * Validate a city form.
 *
 * Coordinates may arrive as separate `lat`/`lng` fields or as one pasted
 * `coordinates` string — "33.51867, -86.80971" is exactly what Google Maps
 * copies when you right-click a place, and asking for two boxes instead invites
 * a swapped pair.
 */
export function parseCityForm(form: SeedForm): CityInput {
  const rawZip = cleanText(form['zip']);
  const zip = normalizeZip(rawZip);
  if (zip === null) throw invalid('A 5-digit zip code is required.');

  const city = cleanText(form['city']);
  if (city === null) throw invalid('The city name is required.');
  if (city.length > 100) throw invalid('That city name is too long.');

  const stateCode = normalizeStateCode(cleanText(form['stateCode']));
  if (stateCode === null) throw invalid('The state must be a 2-letter code, such as GA.');

  let lat = cleanNumber(form['lat']);
  let lng = cleanNumber(form['lng']);
  const pasted = cleanText(form['coordinates']);
  if (pasted !== null) {
    const parts = pasted.split(/[,\s]+/).filter((p) => p !== '');
    lat = parts.length === 2 ? cleanNumber(parts[0]) : null;
    lng = parts.length === 2 ? cleanNumber(parts[1]) : null;
  }
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    throw invalid(
      'Coordinates are required, as "latitude, longitude".',
      'In Google Maps, right-click the city centre and click the numbers at the top to copy them.',
    );
  }

  const population = cleanNumber(form['population']);
  if (population !== null && (population < 0 || !Number.isInteger(population))) {
    throw invalid('Population must be a whole number.');
  }

  return {
    zip,
    city,
    stateCode,
    state: cleanText(form['state']) ?? STATE_NAMES[stateCode] ?? stateCode,
    county: cleanText(form['county']),
    lat,
    lng,
    population,
  };
}

/** Validate a service form. Aliases are separated by `|` or `;`, as in the importer. */
export function parseCategoryForm(form: SeedForm): CategoryInput {
  const name = cleanText(form['name']);
  if (name === null) throw invalid('The service name is required.');
  if (name.length > 120) throw invalid('That service name is too long.');

  const weight = cleanNumber(form['weight']) ?? 1;
  if (weight < 0 || weight > 100) throw invalid('Weight must be between 0 and 100.');

  const rawAliases = cleanText(form['aliases']);
  const aliases =
    rawAliases === null
      ? null
      : rawAliases
          .split(/[|;]/)
          .map((a) => a.trim())
          .filter((a) => a !== '');

  return { name, slug: slugify(name), weight, aliases };
}

class Seeds {
  readonly cities: CitiesRepository;
  readonly categories: CategoriesRepository;
  readonly seedJobs: SeedJobsRepository;
  readonly jobs: JobsRepository;

  constructor(readonly driver: SqliteDriver) {
    this.cities = new CitiesRepository(driver);
    this.categories = new CategoriesRepository(driver);
    this.seedJobs = new SeedJobsRepository(driver, AUTOMATION_ID);
    this.jobs = new JobsRepository(driver);
  }

  city(id: number): CityRecord {
    const city = this.cities.byId(id);
    if (city === null) throw new SeedError(`No city with id ${id}.`, { code: 'SEED_NOT_FOUND' });
    return city;
  }

  category(id: number): CategoryRecord {
    const category = this.categories.byId(id);
    if (category === null) {
      throw new SeedError(`No service with id ${id}.`, { code: 'SEED_NOT_FOUND' });
    }
    return category;
  }

  label(kind: SeedKind, id: number): string {
    if (kind === 'city') {
      const c = this.city(id);
      return `${c.city}, ${c.state_code}`;
    }
    return this.category(id).name;
  }

  /** The jobs this seed should have against every other active seed. */
  specsFor(kind: SeedKind, id: number, counterpartsActiveOnly: boolean) {
    return kind === 'city'
      ? planGoogleMapsJobs([this.city(id)], this.categories.all(counterpartsActiveOnly), {
          automationId: AUTOMATION_ID,
        })
      : planGoogleMapsJobs(this.cities.all(counterpartsActiveOnly), [this.category(id)], {
          automationId: AUTOMATION_ID,
        });
  }

  /**
   * Create this seed's missing jobs, if a queue exists to add them to, and slot
   * them into the queue order rather than leaving them at the default priority.
   */
  fillQueue(kind: SeedKind, id: number): number {
    if (!this.seedJobs.planned()) return 0;
    const inserted = this.jobs.enqueue(this.specsFor(kind, id, true)).inserted;
    if (inserted > 0) syncQueue(this.driver);
    return inserted;
  }

  /** Carry an edit into the jobs that have not run yet, paused ones included. */
  refreshQueue(kind: SeedKind, id: number): number {
    return this.seedJobs.refresh(this.specsFor(kind, id, false));
  }
}

export interface AddResult {
  readonly id: number;
  /** Jobs created for the new seed. 0 when nothing has been planned yet. */
  readonly jobsCreated: number;
}

export interface UpdateResult {
  /** Queued, paused or failed jobs whose search was rewritten. */
  readonly jobsUpdated: number;
}

export interface ActiveResult {
  /** Jobs moved between `pending` and `paused`. */
  readonly jobsChanged: number;
  /** Jobs created on resume, for pairs that were never planned. */
  readonly jobsCreated: number;
}

export interface RemoveResult {
  readonly jobsRemoved: number;
}

export function addCity(driver: SqliteDriver, form: SeedForm): AddResult {
  const input = parseCityForm(form);
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    const clash = seeds.cities.byZip(input.zip);
    if (clash !== null) {
      throw new SeedError(
        `Zip ${input.zip} is already in the list as ${clash.city}, ${clash.state_code}.`,
        { code: 'SEED_DUPLICATE', hint: 'Edit that city instead of adding it again.' },
      );
    }
    const id = seeds.cities.insert({ ...input, source: 'dashboard' });
    return { id, jobsCreated: seeds.fillQueue('city', id) };
  }, 'immediate');
}

export function updateCity(driver: SqliteDriver, id: number, form: SeedForm): UpdateResult {
  const input = parseCityForm(form);
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    const existing = seeds.city(id);
    const clash = seeds.cities.byZip(input.zip);
    if (clash !== null && clash.id !== id) {
      throw new SeedError(
        `Zip ${input.zip} already belongs to ${clash.city}, ${clash.state_code}.`,
        { code: 'SEED_DUPLICATE' },
      );
    }
    // The form has no FIPS field, and a county code nobody can see should not
    // be wiped by saving an unrelated edit.
    seeds.cities.update(id, { ...input, countyFips: existing.county_fips });
    return { jobsUpdated: seeds.refreshQueue('city', id) };
  }, 'immediate');
}

export function addCategory(driver: SqliteDriver, form: SeedForm): AddResult {
  const input = parseCategoryForm(form);
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    const clash = seeds.categories.bySlug(input.slug);
    if (clash !== null) {
      throw new SeedError(`"${clash.name}" is already in the list.`, {
        code: 'SEED_DUPLICATE',
        hint:
          clash.name === input.name
            ? 'Edit that service instead of adding it again.'
            : `Names are compared ignoring case and punctuation, so "${input.name}" counts as the same service.`,
      });
    }
    const id = seeds.categories.insert(input);
    return { id, jobsCreated: seeds.fillQueue('category', id) };
  }, 'immediate');
}

export function updateCategory(driver: SqliteDriver, id: number, form: SeedForm): UpdateResult {
  const input = parseCategoryForm(form);
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    seeds.category(id);
    const clash = seeds.categories.bySlug(input.slug);
    if (clash !== null && clash.id !== id) {
      throw new SeedError(`"${clash.name}" is already in the list.`, {
        code: 'SEED_DUPLICATE',
      });
    }
    seeds.categories.update(id, input);
    return { jobsUpdated: seeds.refreshQueue('category', id) };
  }, 'immediate');
}

/**
 * Pause or resume a seed.
 *
 * Pausing is the safe way to "remove" something that has already produced
 * leads: nothing more is searched for it, and every lead keeps its origin.
 */
export function setSeedActive(
  driver: SqliteDriver,
  kind: SeedKind,
  id: number,
  active: boolean,
): ActiveResult {
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    const repo = kind === 'city' ? seeds.cities : seeds.categories;
    if (kind === 'city') seeds.city(id);
    else seeds.category(id);
    repo.setActive(id, active);

    // Created first, so the sync below decides their status with everything
    // else. Pausing never creates anything.
    const jobsCreated = active ? seeds.fillQueue(kind, id) : 0;
    return { jobsChanged: syncQueue(driver).statusChanged, jobsCreated };
  }, 'immediate');
}

/**
 * Delete a seed and the jobs planned from it.
 *
 * Refused once the seed has produced leads. Deleting its jobs would cascade to
 * the sightings that say which search found each business, and the city row is
 * what those sightings point at — so the honest options are "keep it" or "pause
 * it", never "delete it and hope".
 */
export function removeSeed(driver: SqliteDriver, kind: SeedKind, id: number): RemoveResult {
  const seeds = new Seeds(driver);
  return driver.transaction(() => {
    const label = seeds.label(kind, id);
    const noun = kind === 'city' ? 'city' : 'service';

    if (seeds.seedJobs.hasLeads(kind, id)) {
      throw new SeedError(`${label} has already produced leads, so it cannot be deleted.`, {
        code: 'SEED_IN_USE',
        hint: `Pause it instead: nothing more is searched for this ${noun}, and its leads keep their origin.`,
      });
    }
    if (seeds.seedJobs.leased(kind, id) > 0) {
      throw new SeedError(`A search for ${label} is running right now.`, {
        code: 'SEED_IN_USE',
        hint: 'Wait for it to finish or stop the scrape, then delete.',
      });
    }

    const jobsRemoved = seeds.seedJobs.removeUnleased(kind, id);
    if (kind === 'city') seeds.cities.delete(id);
    else seeds.categories.delete(id);
    return { jobsRemoved };
  }, 'immediate');
}

/**
 * Rewrite every unstarted job from the current seeds. Run after a bulk import,
 * which can correct hundreds of rows at once.
 */
export function refreshAllJobs(driver: SqliteDriver): number {
  const seeds = new Seeds(driver);
  const refreshed = seeds.seedJobs.refresh(
    planGoogleMapsJobs(seeds.cities.all(false), seeds.categories.all(false), {
      automationId: AUTOMATION_ID,
    }),
  );
  // A changed state code or service weight moves a job in the queue.
  if (refreshed > 0) syncQueue(driver);
  return refreshed;
}

/** Where a seed stands, in the words the dashboard shows. */
export type SeedProgress =
  | 'paused'
  | 'on hold'
  | 'not planned'
  | 'queued'
  | 'running'
  | 'in progress'
  | 'needs retry'
  | 'complete';

export function progressOf(active: boolean, jobs: SeedJobCounts): SeedProgress {
  if (!active) return 'paused';
  if (jobs.total === 0) return 'not planned';
  if (jobs.leased > 0) return 'running';
  const finished = jobs.done + jobs.skipped;
  if (finished === jobs.total) return 'complete';
  if (jobs.pending + jobs.paused === 0) return 'needs retry';
  // Active itself, but nothing of it can run: its state is outside the states
  // the queue is limited to, or every service it pairs with is paused.
  if (jobs.pending === 0) return 'on hold';
  return finished > 0 ? 'in progress' : 'queued';
}

const NO_JOBS: SeedJobCounts = {
  total: 0,
  done: 0,
  pending: 0,
  leased: 0,
  failed: 0,
  skipped: 0,
  paused: 0,
  lastFinishedAt: null,
};

export interface SeedRow<T> {
  readonly seed: T;
  readonly jobs: SeedJobCounts;
  readonly leads: number;
  readonly progress: SeedProgress;
}

/** Every seed of one kind, active or not, with its queue and lead counts. */
export function listCities(driver: SqliteDriver): SeedRow<CityRecord>[] {
  const seedJobs = new SeedJobsRepository(driver, AUTOMATION_ID);
  const counts = seedJobs.counts('city');
  const leads = seedJobs.leads('city');
  return new CitiesRepository(driver).all(false).map((seed) => {
    const jobs = counts.get(seed.id) ?? NO_JOBS;
    return {
      seed,
      jobs,
      leads: leads.get(seed.id) ?? 0,
      progress: progressOf(seed.active === 1, jobs),
    };
  });
}

export function listCategories(driver: SqliteDriver): SeedRow<CategoryRecord>[] {
  const seedJobs = new SeedJobsRepository(driver, AUTOMATION_ID);
  const counts = seedJobs.counts('category');
  const leads = seedJobs.leads('category');
  return new CategoriesRepository(driver).all(false).map((seed) => {
    const jobs = counts.get(seed.id) ?? NO_JOBS;
    return {
      seed,
      jobs,
      leads: leads.get(seed.id) ?? 0,
      progress: progressOf(seed.active === 1, jobs),
    };
  });
}
