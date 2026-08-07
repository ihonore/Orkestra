import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { JobsRepository, type Lease } from '../src/db/repositories/jobs.js';
import { GROUPINGS, ProgressRepository } from '../src/db/repositories/progress.js';
import type { SqliteDriver } from '../src/db/driver/types.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

interface Fixture {
  driver: SqliteDriver;
  jobs: JobsRepository;
  progress: ProgressRepository;
}

/** Two cities x three categories, so grouping has something to collapse. */
function seeded(): Fixture {
  const driver = openDatabase({ file: path.join(tempDir(), 'p.sqlite') });
  migrate(driver);
  const jobs = new JobsRepository(driver);

  const cities = [
    { id: 1, city: 'Atlanta', stateCode: 'GA' },
    { id: 2, city: 'Boston', stateCode: 'MA' },
  ];
  const categories = [
    { id: 10, category: 'Plumber' },
    { id: 11, category: 'Roofer' },
    { id: 12, category: 'Electrician' },
  ];

  jobs.enqueue(
    cities.flatMap((c) =>
      categories.map((k) => ({
        automationId: 'google-maps',
        taskKey: `city:${c.id}|cat:${k.id}`,
        params: { cityId: c.id, ...c, categoryId: k.id, ...k },
      })),
    ),
  );

  return { driver, jobs, progress: new ProgressRepository(driver) };
}

const CLAIM = { automationId: 'google-maps', owner: 'w1', leaseMs: 60_000, runId: 'r' };

function completeNext(jobs: JobsRepository, count: number): Lease[] {
  const done: Lease[] = [];
  for (let i = 0; i < count; i += 1) {
    const lease = jobs.claim(CLAIM);
    if (lease === null) break;
    jobs.complete(lease, 5);
    done.push(lease);
  }
  return done;
}

describe('progress grouping', () => {
  it('collapses jobs into one row per city, not one per job', () => {
    // Regression: `GROUP BY id` bound to the real jobs.id column rather than the
    // SELECT alias, so every job became its own "group" and the view showed 185
    // cities x 85 rows of "0/1".
    const { driver, progress } = seeded();
    try {
      const groups = progress.groups({ automationId: 'google-maps', ...GROUPINGS.city });

      expect(groups).toHaveLength(2);
      expect(groups.every((g) => g.total === 3)).toBe(true);
      expect(new Set(groups.map((g) => g.label))).toEqual(new Set(['Atlanta', 'Boston']));
    } finally {
      driver.close();
    }
  });

  it('groups by category independently of city', () => {
    const { driver, progress } = seeded();
    try {
      const groups = progress.groups({ automationId: 'google-maps', ...GROUPINGS.category });
      expect(groups).toHaveLength(3);
      expect(groups.every((g) => g.total === 2)).toBe(true);
    } finally {
      driver.close();
    }
  });

  it('counts each status separately', () => {
    const { driver, jobs, progress } = seeded();
    try {
      completeNext(jobs, 2);
      const live = jobs.claim(CLAIM)!;
      const failed = jobs.claim(CLAIM)!;
      jobs.fail(failed, { error: 'blocked', errorKind: 'blocked' });

      const all = progress.groups({ automationId: 'google-maps', ...GROUPINGS.city });
      const totals = all.reduce(
        (acc, g) => ({
          done: acc.done + g.done,
          leased: acc.leased + g.leased,
          pending: acc.pending + g.pending,
        }),
        { done: 0, leased: 0, pending: 0 },
      );

      expect(totals.done).toBe(2);
      expect(totals.leased).toBe(1);
      expect(live.job.id).toBeGreaterThan(0);
    } finally {
      driver.close();
    }
  });

  it('orders by completion, so finished groups surface first', () => {
    const { driver, jobs, progress } = seeded();
    try {
      completeNext(jobs, 3); // drains one city entirely
      const groups = progress.groups({ automationId: 'google-maps', ...GROUPINGS.city });
      expect(groups[0]?.done).toBe(3);
      expect(groups[1]?.done).toBe(0);
    } finally {
      driver.close();
    }
  });

  it('hides finished groups when only incomplete ones are wanted', () => {
    const { driver, jobs, progress } = seeded();
    try {
      completeNext(jobs, 3);
      const groups = progress.groups({
        automationId: 'google-maps',
        ...GROUPINGS.city,
        incompleteOnly: true,
      });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.done).toBe(0);
    } finally {
      driver.close();
    }
  });

  it('keeps a group with failures visible, since that is what needs attention', () => {
    const { driver, jobs, progress } = seeded();
    try {
      // Exhaust one job's attempts so the group is 2 done + 1 failed.
      const first = jobs.claim(CLAIM)!;
      jobs.fail(first, { error: 'blocked', retryAt: 0 });
      for (let i = 0; i < 5; i += 1) {
        const lease = jobs.claim({ ...CLAIM, now: Date.now() + 60_000 });
        if (lease === null) break;
        if (lease.job.id === first.job.id) jobs.fail(lease, { error: 'blocked', retryAt: 0 });
        else jobs.complete(lease, 1);
      }

      const groups = progress.groups({
        automationId: 'google-maps',
        ...GROUPINGS.city,
        incompleteOnly: true,
      });
      expect(groups.some((g) => g.failed > 0)).toBe(true);
    } finally {
      driver.close();
    }
  });

  it('does not mix automations', () => {
    const { driver, jobs, progress } = seeded();
    try {
      jobs.enqueue([{ automationId: 'yellow-pages', taskKey: 'x', params: { cityId: 99 } }]);
      const groups = progress.groups({ automationId: 'google-maps', ...GROUPINGS.city });
      expect(groups).toHaveLength(2);
    } finally {
      driver.close();
    }
  });

  it('returns nothing for an automation with no jobs', () => {
    const { driver, progress } = seeded();
    try {
      expect(progress.groups({ automationId: 'nope', ...GROUPINGS.city })).toEqual([]);
    } finally {
      driver.close();
    }
  });
});
