import { describe, expect, it } from 'vitest';
import { planGoogleMapsJobs, priorityFor, taskKeyFor } from '../src/core/engine/planner.js';
import { busyBackoffMs, isBusyError, retryOnBusy } from '../src/db/busy.js';
import type { CategoryRecord, CityRecord } from '../src/db/repositories/seeds.js';

function city(overrides: Partial<CityRecord> = {}): CityRecord {
  return {
    id: 1,
    zip: '35203',
    city: 'Birmingham',
    state: 'Alabama',
    state_code: 'AL',
    county: 'Jefferson',
    county_fips: '01073',
    lat: 33.51,
    lng: -86.8,
    population: null,
    active: 1,
    legacy_status: null,
    source: null,
    ...overrides,
  };
}

function category(overrides: Partial<CategoryRecord> = {}): CategoryRecord {
  return {
    id: 1,
    name: 'Plumber',
    slug: 'plumber',
    aliases: null,
    weight: 1,
    active: 1,
    legacy_status: null,
    ...overrides,
  };
}

describe('taskKeyFor', () => {
  it('is built from ids, so renaming a city does not orphan its jobs', () => {
    expect(taskKeyFor(12, 7)).toBe('city:12|cat:7');
  });

  it('is unique per pair', () => {
    expect(taskKeyFor(1, 2)).not.toBe(taskKeyFor(2, 1));
  });
});

describe('planGoogleMapsJobs', () => {
  it('produces the full cross product', () => {
    const cities = [city({ id: 1 }), city({ id: 2, zip: '30301' })];
    const categories = [category({ id: 1 }), category({ id: 2, slug: 'roofer' })];

    const specs = planGoogleMapsJobs(cities, categories);

    expect(specs).toHaveLength(4);
    expect(new Set(specs.map((s) => s.taskKey)).size).toBe(4);
  });

  it('carries enough params to run without re-reading the seeds', () => {
    const specs = planGoogleMapsJobs([city()], [category()]);
    expect(specs[0]?.params).toMatchObject({
      city: 'Birmingham',
      stateCode: 'AL',
      category: 'Plumber',
      lat: 33.51,
      lng: -86.8,
    });
  });

  it('orders by priority, highest first', () => {
    const specs = planGoogleMapsJobs(
      [city({ id: 1, population: 1000 }), city({ id: 2, population: 1_000_000 })],
      [category()],
    );
    expect(specs[0]?.taskKey).toBe(taskKeyFor(2, 1));
  });

  it('applies a limit to the highest-priority jobs', () => {
    // Populations an order of magnitude apart, so the log scale separates them
    // cleanly rather than rounding them into ties.
    const cities = Array.from({ length: 6 }, (_, i) =>
      city({ id: i + 1, zip: `1000${i}`, population: 10 ** (i + 1) }),
    );
    const specs = planGoogleMapsJobs(cities, [category()], { limit: 3 });

    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.taskKey)).toEqual([
      taskKeyFor(6, 1),
      taskKeyFor(5, 1),
      taskKeyFor(4, 1),
    ]);
  });

  it('ties cities of similar size rather than inventing false precision', () => {
    // Priority is an integer column, and 9k vs 10k population is not a real
    // difference in lead value. Ties are resolved by id, keeping plan order
    // deterministic across runs.
    const specs = planGoogleMapsJobs(
      [city({ id: 1, population: 9_000 }), city({ id: 2, zip: '30301', population: 10_000 })],
      [category()],
    );
    expect(specs[0]?.priority).toBe(specs[1]?.priority);
  });
});

describe('priorityFor', () => {
  it('ranks a larger city above a smaller one', () => {
    const big = priorityFor(city({ population: 2_000_000 }), category());
    const small = priorityFor(city({ population: 5_000 }), category());
    expect(big).toBeGreaterThan(small);
  });

  it('log-scales population so it cannot swamp category weight entirely', () => {
    // A 400x population difference must not be worth more than every category
    // distinction combined, or category weight would never matter.
    const huge = priorityFor(city({ population: 2_000_000 }), category({ weight: 1 }));
    const smallButValuable = priorityFor(city({ population: 5_000 }), category({ weight: 5 }));
    expect(smallButValuable).toBeGreaterThan(huge);
  });

  it('handles cities with no population data', () => {
    expect(priorityFor(city({ population: null }), category())).toBe(10);
  });
});

describe('busy-error classification', () => {
  it('classifies on code, not message', () => {
    // The message is "database is locked" — matching on it would never fire.
    expect(isBusyError({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(true);
    expect(isBusyError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
  });

  it('does not treat real errors as contention', () => {
    expect(isBusyError({ code: 'SQLITE_CONSTRAINT' })).toBe(false);
    expect(isBusyError(new Error('database is locked'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe('retryOnBusy', () => {
  it('returns the value when there is no contention', async () => {
    await expect(retryOnBusy(() => 42)).resolves.toBe(42);
  });

  it('retries until the lock clears', async () => {
    let calls = 0;
    const result = await retryOnBusy(
      () => {
        calls += 1;
        if (calls < 3)
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return 'ok';
      },
      { baseDelayMs: 1 },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows a non-contention error immediately', async () => {
    let calls = 0;
    await expect(
      retryOnBusy(() => {
        calls += 1;
        throw Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT' });
      }),
    ).rejects.toThrow('constraint');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      retryOnBusy(
        () => {
          calls += 1;
          throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
        },
        { attempts: 4, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('locked');
    expect(calls).toBe(4);
  });
});

describe('busyBackoffMs', () => {
  it('grows exponentially up to the cap', () => {
    const full = { random: () => 1, baseDelayMs: 5, maxDelayMs: 100 };
    expect(busyBackoffMs(1, full)).toBe(5);
    expect(busyBackoffMs(2, full)).toBe(10);
    expect(busyBackoffMs(3, full)).toBe(20);
    expect(busyBackoffMs(10, full)).toBe(100);
  });

  it('jitters across the whole window, so workers do not re-collide in lockstep', () => {
    expect(busyBackoffMs(4, { random: () => 0, baseDelayMs: 5 })).toBe(0);
    expect(busyBackoffMs(4, { random: () => 0.5, baseDelayMs: 5 })).toBe(20);
    expect(busyBackoffMs(4, { random: () => 1, baseDelayMs: 5 })).toBe(40);
  });
});
