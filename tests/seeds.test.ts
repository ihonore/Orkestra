/**
 * Seed management tests.
 *
 * The seed rows are the easy half. What these tests pin down is the other half:
 * that every edit leaves the queue matching the rule "active city x active
 * service, and nothing else claimable" — and that nothing which produced leads
 * can be deleted out from under them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { JobsRepository } from '../src/db/repositories/jobs.js';
import { SeedJobsRepository } from '../src/db/repositories/seed-jobs.js';
import {
  normalizePlan,
  queueView,
  readQueuePlan,
  setQueuePlan,
  syncQueue,
} from '../src/seeds/queue.js';
import { CategoriesRepository, CitiesRepository } from '../src/db/repositories/seeds.js';
import { planGoogleMapsJobs } from '../src/core/engine/planner.js';
import {
  addCategory,
  addCity,
  listCities,
  parseCityForm,
  progressOf,
  refreshAllJobs,
  removeSeed,
  setSeedActive,
  updateCategory,
  updateCity,
} from '../src/seeds/manage.js';
import {
  bundledSeedsDir,
  loadBundledSeeds,
  loadBundledSeedsOnce,
  saveSeedFiles,
  SEED_FILES,
} from '../src/seeds/bundled.js';
import { cleanupTempDirs, tempDir, writeFile } from './helpers.js';

afterEach(cleanupTempDirs);

const ATLANTA = { city: 'Atlanta', stateCode: 'GA', zip: '30303', coordinates: '33.75, -84.39' };
const BOSTON = { city: 'Boston', stateCode: 'MA', zip: '2108', lat: 42.35, lng: -71.06 };

function database(): SqliteDriver {
  const driver = openDatabase({ file: path.join(tempDir(), 's.sqlite') });
  migrate(driver);
  return driver;
}

/** Two cities x two services, planned. */
function planned(): { driver: SqliteDriver; cities: number[]; categories: number[] } {
  const driver = database();
  const cities = [addCity(driver, ATLANTA).id, addCity(driver, BOSTON).id];
  const categories = [
    addCategory(driver, { name: 'Plumber' }).id,
    addCategory(driver, { name: 'Roofing' }).id,
  ];
  new JobsRepository(driver).enqueue(
    planGoogleMapsJobs(new CitiesRepository(driver).all(), new CategoriesRepository(driver).all()),
  );
  return { driver, cities, categories };
}

function statuses(driver: SqliteDriver, where = '1 = 1'): Record<string, number> {
  return Object.fromEntries(
    driver
      .prepare<{ status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE ${where} GROUP BY status`,
      )
      .all()
      .map((r) => [r.status, r.n]),
  );
}

function cityJobs(cityId: number): string {
  return `json_extract(params_json, '$.cityId') = ${cityId}`;
}

/** Record that a business was found by searching this job. */
function sighting(driver: SqliteDriver, cityId: number, categoryId: number): void {
  const job = driver
    .prepare<{ id: number }>(
      `SELECT id FROM jobs WHERE json_extract(params_json, '$.cityId') = ?
          AND json_extract(params_json, '$.categoryId') = ?`,
    )
    .get([cityId, categoryId])!;
  const business = driver
    .prepare<{ id: number }>(
      `INSERT INTO businesses (dedup_hash, name, automation_id, first_seen_at, last_seen_at)
       VALUES (?, 'Acme', 'google-maps', 0, 0) RETURNING id`,
    )
    .get([`h${job.id}`])!;
  driver
    .prepare(
      `INSERT INTO business_sightings (business_id, job_id, run_id, seed_city_id,
                                       seed_category_id, search_query, seen_at)
       VALUES (?, ?, 'r', ?, ?, 'q', 0)`,
    )
    .run([business.id, job.id, cityId, categoryId]);
}

describe('city form', () => {
  it('accepts coordinates pasted from Google Maps', () => {
    const city = parseCityForm(ATLANTA);
    expect(city.lat).toBe(33.75);
    expect(city.lng).toBe(-84.39);
  });

  it('repairs a zip that lost its leading zero, and names the state', () => {
    const city = parseCityForm(BOSTON);
    expect(city.zip).toBe('02108');
    expect(city.state).toBe('Massachusetts');
  });

  it('refuses missing coordinates with a hint on where to find them', () => {
    expect(() => parseCityForm({ ...ATLANTA, coordinates: 'here' })).toThrow(/Coordinates/);
  });

  it('refuses a state that is not a 2-letter code', () => {
    expect(() => parseCityForm({ ...ATLANTA, stateCode: 'Georgia' })).toThrow(/2-letter/);
  });
});

describe('adding', () => {
  it('only touches seeds before anything has been planned', () => {
    const driver = database();
    addCategory(driver, { name: 'Plumber' });
    expect(addCity(driver, ATLANTA).jobsCreated).toBe(0);
    expect(new JobsRepository(driver).counts('google-maps').pending).toBe(0);
  });

  it('queues the new seed against every active counterpart once a plan exists', () => {
    const { driver } = planned();
    const result = addCity(driver, { ...ATLANTA, city: 'Macon', zip: '31201' });
    expect(result.jobsCreated).toBe(2);
  });

  it('refuses a zip that is already in the list', () => {
    const { driver } = planned();
    expect(() => addCity(driver, { ...ATLANTA, city: 'Elsewhere' })).toThrow(/already in the list/);
  });

  it('refuses a service whose name differs only in case and punctuation', () => {
    const { driver } = planned();
    expect(() => addCategory(driver, { name: 'plumber!' })).toThrow(/already in the list/);
  });
});

describe('editing', () => {
  it('rewrites the searches not yet run, and leaves finished ones as they ran', () => {
    const { driver, cities } = planned();
    const jobs = new JobsRepository(driver);
    const lease = jobs.claim({
      automationId: 'google-maps',
      owner: 'w',
      leaseMs: 60_000,
      runId: 'r',
    })!;
    jobs.complete(lease, 3);
    const doneCity = (JSON.parse(lease.job.params_json) as { cityId: number }).cityId;

    const result = updateCity(driver, doneCity, {
      ...(doneCity === cities[0] ? ATLANTA : BOSTON),
      coordinates: '10, 20',
    });
    expect(result.jobsUpdated).toBe(1);

    const params = driver
      .prepare<{ status: string; params_json: string }>(
        `SELECT status, params_json FROM jobs WHERE ${cityJobs(doneCity)}`,
      )
      .all()
      .map((r) => ({ status: r.status, lat: (JSON.parse(r.params_json) as { lat: number }).lat }));
    expect(params.find((p) => p.status === 'pending')?.lat).toBe(10);
    expect(params.find((p) => p.status === 'done')?.lat).not.toBe(10);
  });

  it('keeps the county code the form cannot show', () => {
    const driver = database();
    new CitiesRepository(driver).upsertMany([{ ...parseCityForm(ATLANTA), countyFips: '13121' }]);
    const id = new CitiesRepository(driver).byZip('30303')!.id;
    updateCity(driver, id, { ...ATLANTA, county: 'Fulton' });
    expect(new CitiesRepository(driver).byId(id)!.county_fips).toBe('13121');
  });

  it('refuses a rename onto another service', () => {
    const { driver, categories } = planned();
    expect(() => updateCategory(driver, categories[0]!, { name: 'Roofing' })).toThrow(/already/);
  });

  it('reports nothing when an import changes nothing', () => {
    const { driver } = planned();
    expect(refreshAllJobs(driver)).toBe(0);
  });
});

describe('pausing', () => {
  it("parks a city's queued searches and brings them back on resume", () => {
    const { driver, cities } = planned();
    expect(setSeedActive(driver, 'city', cities[0]!, false).jobsChanged).toBe(2);
    expect(statuses(driver, cityJobs(cities[0]!))).toEqual({ paused: 2 });
    expect(new JobsRepository(driver).counts('google-maps').pending).toBe(2);

    expect(setSeedActive(driver, 'city', cities[0]!, true).jobsChanged).toBe(2);
    expect(statuses(driver)).toEqual({ pending: 4 });
  });

  it('does not resume a pair whose service is still paused', () => {
    const { driver, cities, categories } = planned();
    setSeedActive(driver, 'category', categories[0]!, false);
    setSeedActive(driver, 'city', cities[0]!, false);
    setSeedActive(driver, 'city', cities[0]!, true);
    expect(statuses(driver, cityJobs(cities[0]!))).toEqual({ paused: 1, pending: 1 });
  });

  it('creates the pairs a paused seed missed while it was paused', () => {
    const { driver, cities } = planned();
    setSeedActive(driver, 'city', cities[0]!, false);
    addCategory(driver, { name: 'Electrician' });
    expect(setSeedActive(driver, 'city', cities[0]!, true).jobsCreated).toBe(1);
  });

  it('re-parks a paused seed job that drifted back to pending', () => {
    const { driver, cities } = planned();
    setSeedActive(driver, 'city', cities[0]!, false);
    new JobsRepository(driver).retry({ automationId: 'google-maps', status: 'paused' });
    expect(syncQueue(driver).statusChanged).toBe(2);
    expect(statuses(driver, cityJobs(cities[0]!))).toEqual({ paused: 2 });
  });

  it('shows a paused seed as paused, not complete', () => {
    const { driver, cities } = planned();
    setSeedActive(driver, 'city', cities[0]!, false);
    const row = listCities(driver).find((r) => r.seed.id === cities[0]);
    expect(row?.progress).toBe('paused');
  });
});

describe('deleting', () => {
  it('removes a seed that never produced leads, with its planned searches', () => {
    const { driver, cities } = planned();
    expect(removeSeed(driver, 'city', cities[0]!).jobsRemoved).toBe(2);
    expect(new CitiesRepository(driver).byId(cities[0]!)).toBeNull();
    expect(statuses(driver)).toEqual({ pending: 2 });
  });

  it('refuses once the seed has produced leads, and suggests pausing', () => {
    const { driver, cities, categories } = planned();
    sighting(driver, cities[0]!, categories[0]!);
    expect(() => removeSeed(driver, 'city', cities[0]!)).toThrow(/cannot be deleted/);
    expect(() => removeSeed(driver, 'category', categories[0]!)).toThrow(/cannot be deleted/);
    expect(new CitiesRepository(driver).byId(cities[0]!)).not.toBeNull();
  });

  it('refuses while one of its searches is running', () => {
    const { driver } = planned();
    const lease = new JobsRepository(driver).claim({
      automationId: 'google-maps',
      owner: 'w',
      leaseMs: 60_000,
      runId: 'r',
    })!;
    const { cityId } = JSON.parse(lease.job.params_json) as { cityId: number };
    expect(() => removeSeed(driver, 'city', cityId)).toThrow(/running right now/);
  });
});

describe('progress labels', () => {
  const none = { total: 0, done: 0, pending: 0, leased: 0, failed: 0, skipped: 0, paused: 0 };
  it.each([
    [true, none, 'not planned'],
    [true, { ...none, total: 2, pending: 2 }, 'queued'],
    [true, { ...none, total: 2, done: 1, pending: 1 }, 'in progress'],
    [true, { ...none, total: 2, done: 1, failed: 1 }, 'needs retry'],
    [true, { ...none, total: 2, done: 1, skipped: 1 }, 'complete'],
    [true, { ...none, total: 2, leased: 1, pending: 1 }, 'running'],
    [false, { ...none, total: 2, done: 2 }, 'paused'],
  ] as const)('active=%s %o is %s', (active, counts, expected) => {
    expect(progressOf(active, { ...counts, lastFinishedAt: null })).toBe(expected);
  });
});

describe('bundled seeds', () => {
  function seedDir(): string {
    const dir = tempDir();
    writeFile(
      dir,
      SEED_FILES.cities,
      'Zip,City,State,State Code,Latitude,Longitude,Active\r\n' +
        '901,San Juan,Puerto Rico,PR,18.46,-66.10,yes\r\n' +
        '30303,Atlanta,Georgia,GA,33.75,-84.39,no\r\n',
    );
    writeFile(
      dir,
      SEED_FILES.categories,
      'Name,Weight,Aliases\r\n"Plumber, residential",2,Drain|Pipe\r\n',
    );
    return dir;
  }

  it('ships with the project, so a fresh checkout has its lists', () => {
    const dir = bundledSeedsDir();
    expect(fs.existsSync(path.join(dir, SEED_FILES.cities))).toBe(true);
    expect(fs.existsSync(path.join(dir, SEED_FILES.categories))).toBe(true);
  });

  it('loads the shipped files without rejecting a row', () => {
    const driver = database();
    const result = loadBundledSeeds(driver);
    expect(result.cities?.rejected).toEqual([]);
    expect(result.categories?.rejected).toEqual([]);
    expect(result.cities!.result.inserted).toBeGreaterThan(100);
    // Leading zeros survive the round trip through a CSV.
    expect(new CitiesRepository(driver).byZip('00901')?.city).toBe('San Juan');
  });

  it('loads once into an empty database, and never again', () => {
    const driver = database();
    const dir = seedDir();
    expect(loadBundledSeedsOnce(driver, dir)?.cities?.result.inserted).toBe(2);

    // Deleting every city on purpose must not be undone by the next migrate.
    driver.exec('DELETE FROM cities');
    expect(loadBundledSeedsOnce(driver, dir)).toBeNull();
    expect(new CitiesRepository(driver).count(false)).toBe(0);
  });

  it('leaves a database that already has its own lists alone', () => {
    const driver = database();
    addCity(driver, BOSTON);
    expect(loadBundledSeedsOnce(driver, seedDir())?.cities ?? null).toBeNull();
    expect(new CitiesRepository(driver).count(false)).toBe(1);
  });

  it('applies the Active column on insert, but never un-pauses on reload', () => {
    const driver = database();
    const dir = seedDir();
    loadBundledSeeds(driver, { dir });
    const atlanta = new CitiesRepository(driver).byZip('30303')!;
    expect(atlanta.active).toBe(0);

    const sanJuan = new CitiesRepository(driver).byZip('00901')!;
    setSeedActive(driver, 'city', sanJuan.id, false);
    loadBundledSeeds(driver, { dir });
    expect(new CitiesRepository(driver).byZip('00901')!.active).toBe(0);
  });

  it('saves the current lists in a form that loads back identically', () => {
    const source = database();
    loadBundledSeeds(source, { dir: seedDir() });
    const out = tempDir();
    expect(saveSeedFiles(source, out)).toMatchObject({ cities: 2, categories: 1 });

    const copy = database();
    loadBundledSeeds(copy, { dir: out });
    const strip = (rows: object[]) =>
      rows.map((r) => {
        const { id: _id, source: _source, ...rest } = r as Record<string, unknown>;
        return rest;
      });
    expect(strip(new CitiesRepository(copy).all(false))).toEqual(
      strip(new CitiesRepository(source).all(false)),
    );
    expect(strip(new CategoriesRepository(copy).all(false))).toEqual(
      strip(new CategoriesRepository(source).all(false)),
    );
    expect(fs.readdirSync(out).sort()).toEqual([SEED_FILES.cities, SEED_FILES.categories].sort());
  });
});

describe('queue order', () => {
  const STATES = ['AL', 'AK', 'GA', 'TX', 'NY'];

  /** Two cities in each of five states, four services, planned. */
  function country(): SqliteDriver {
    const driver = database();
    STATES.forEach((state, s) => {
      for (let c = 0; c < 2; c += 1) {
        addCity(driver, {
          city: `${state} City ${c}`,
          stateCode: state,
          zip: String(10000 + s * 10 + c),
          coordinates: '30, -90',
        });
      }
    });
    for (const name of ['Plumber', 'Roofing', 'Dentist', 'Lawyer']) addCategory(driver, { name });
    new JobsRepository(driver).enqueue(
      planGoogleMapsJobs(
        new CitiesRepository(driver).all(),
        new CategoriesRepository(driver).all(),
      ),
    );
    syncQueue(driver);
    return driver;
  }

  function next(driver: SqliteDriver, n: number) {
    return new SeedJobsRepository(driver).nextUp(n);
  }

  it('spreads by default: the first round touches every state once', () => {
    const driver = country();
    const first = next(driver, STATES.length);
    expect(new Set(first.map((j) => j.stateCode)).size).toBe(STATES.length);
  });

  it('rotates services across a round rather than repeating one', () => {
    const driver = country();
    const first = next(driver, STATES.length);
    expect(new Set(first.map((j) => j.category)).size).toBeGreaterThan(1);
  });

  it('rotates cities within a state before repeating one', () => {
    const driver = country();
    const firstTwoRounds = next(driver, STATES.length * 2).filter((j) => j.stateCode === 'TX');
    expect(new Set(firstTwoRounds.map((j) => j.city)).size).toBe(2);
  });

  it('holds back a state that already has many finished searches', () => {
    const driver = country();
    // Finish Alabama's searches by hand, as an earlier alphabetical run did.
    driver.exec(
      `UPDATE jobs SET status = 'done', finished_at = 1
        WHERE json_extract(params_json, '$.stateCode') = 'AL'
          AND json_extract(params_json, '$.category') IN ('Plumber', 'Roofing', 'Dentist')`,
    );
    syncQueue(driver);
    const states = next(driver, (STATES.length - 1) * 3).map((j) => j.stateCode);
    expect(states).not.toContain('AL');
  });

  it('can finish one state at a time instead', () => {
    const driver = country();
    setQueuePlan(driver, { order: 'by-state' });
    expect(new Set(next(driver, 8).map((j) => j.stateCode))).toEqual(new Set(['AK']));
  });

  it('puts chosen states first, still spread between them', () => {
    const driver = country();
    setQueuePlan(driver, { states: ['tx', 'NY'] });
    const first = next(driver, 16).map((j) => j.stateCode);
    expect(new Set(first)).toEqual(new Set(['NY', 'TX']));
    expect(first.slice(0, 2).sort()).toEqual(['NY', 'TX']);
    // The rest still follow once those are exhausted.
    expect(new Set(next(driver, 40).map((j) => j.stateCode)).size).toBe(STATES.length);
  });

  it('can search only the chosen states, and lets the rest wait as paused', () => {
    const driver = country();
    const result = setQueuePlan(driver, { states: ['GA'], only: true });
    expect(result.statusChanged).toBe(32);
    expect(new Set(next(driver, 40).map((j) => j.stateCode))).toEqual(new Set(['GA']));
    expect(listCities(driver).find((r) => r.seed.state_code === 'TX')?.progress).toBe('on hold');

    // Lifting the restriction resumes them; a city paused by hand stays paused.
    const texas = new CitiesRepository(driver).all().find((c) => c.state_code === 'TX')!;
    setSeedActive(driver, 'city', texas.id, false);
    setQueuePlan(driver, { states: [], only: false });
    expect(statuses(driver, cityJobs(texas.id))).toEqual({ paused: 4 });
    expect(new JobsRepository(driver).counts('google-maps').pending).toBe(36);
  });

  it('keeps a heavier service ahead of position', () => {
    const driver = country();
    const roofing = new CategoriesRepository(driver).bySlug('roofing')!;
    updateCategory(driver, roofing.id, { name: 'Roofing', weight: 5 });
    syncQueue(driver);
    expect(new Set(next(driver, 10).map((j) => j.category))).toEqual(new Set(['Roofing']));
  });

  it('slots new searches into the order instead of leaving them last', () => {
    const driver = country();
    setQueuePlan(driver, { states: ['FL'] });
    addCity(driver, { city: 'Miami', stateCode: 'FL', zip: '33101', coordinates: '25.77, -80.19' });
    expect(next(driver, 4).map((j) => j.stateCode)).toEqual(['FL', 'FL', 'FL', 'FL']);
  });

  it('stores the plan with the database and cleans what it is given', () => {
    const driver = country();
    setQueuePlan(driver, { order: 'nonsense', states: ['tx', 'TX', 'Texas', 7], only: true });
    expect(readQueuePlan(driver)).toEqual({ order: 'spread', states: ['TX'], only: true });
  });

  it('treats "only these states" with none chosen as no restriction', () => {
    expect(normalizePlan({ only: true, states: [] })).toEqual({
      order: 'spread',
      states: [],
      only: false,
    });
  });

  it('summarises every state for the picker', () => {
    const driver = country();
    const view = queueView(driver);
    expect(view.states.map((s) => s.code)).toEqual([...STATES].sort());
    expect(view.states.find((s) => s.code === 'TX')).toMatchObject({ cities: 2, remaining: 8 });
    expect(view.next).toHaveLength(8);
  });
});
