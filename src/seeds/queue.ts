/**
 * Which search runs next.
 *
 * Every job used to get the same priority, so the claim fell back to insertion
 * order — and the planner inserts state by state, alphabetically. A sweep that
 * takes weeks therefore spent its first days entirely in Alabama and Alaska,
 * and the leads it had produced were all from two states.
 *
 * The order is now computed across the whole queue and written into
 * `priority`, which the claim already sorts by (and indexes). Two orders:
 *
 *  - **spread** (the default): round-robin across states. Each round gives
 *    every state one search, rotating through its cities and through the
 *    services, so the first fifty searches touch fifty states and a dozen
 *    services rather than one city and one service. A state that already has
 *    many finished searches starts that many rounds later, so the backlog
 *    evens out instead of the early states staying ahead.
 *  - **by-state**: finish one state before the next, alphabetically — the old
 *    behaviour, for when one complete state is worth more than breadth.
 *
 * On top of either, states can be put **first** (searched before the rest) or
 * made the **only** ones searched (the rest wait as `paused`). Service weight
 * still applies within that: a heavier service runs before a lighter one.
 *
 * The plan is stored in the database, so a scrape started from the CLI, the
 * dashboard or another machine with a copy of the database all follow it.
 */
import type { SqliteDriver } from '../db/driver/types.js';
import { MetaRepository } from '../db/repositories/meta.js';
import { SeedJobsRepository, type UnstartedJob } from '../db/repositories/seed-jobs.js';
import {
  CategoriesRepository,
  CitiesRepository,
  type CategoryRecord,
  type CityRecord,
} from '../db/repositories/seeds.js';
import { normalizeStateCode } from '../importers/normalize.js';

const AUTOMATION_ID = 'google-maps';
const PLAN_KEY = 'queue_plan';

export type QueueOrder = 'spread' | 'by-state';

export interface QueuePlan {
  readonly order: QueueOrder;
  /** State codes to favour. Empty means no preference. */
  readonly states: readonly string[];
  /** True: search only `states`. False: search them first, then the rest. */
  readonly only: boolean;
}

export const DEFAULT_PLAN: QueuePlan = { order: 'spread', states: [], only: false };

/**
 * Priority bands. Each one dominates everything below it, so a focused state
 * always beats weight, and weight always beats position. Positions stay well
 * under `POSITION_SPAN` (15,725 today); weights are 0–100, so the largest
 * priority is ~1.0e13 — far inside SQLite's 64-bit integers.
 */
const FOCUS_BAND = 10_000_000_000_000;
const WEIGHT_BAND = 10_000_000;
const POSITION_SPAN = 10_000_000;

export function readQueuePlan(driver: SqliteDriver): QueuePlan {
  const raw = new MetaRepository(driver).get(PLAN_KEY);
  if (raw === undefined) return DEFAULT_PLAN;
  try {
    return normalizePlan(JSON.parse(raw) as Partial<QueuePlan>);
  } catch {
    return DEFAULT_PLAN;
  }
}

/** Coerce anything — a form, a CLI flag, an old stored value — into a valid plan. */
export function normalizePlan(input: Partial<Record<keyof QueuePlan, unknown>>): QueuePlan {
  const order: QueueOrder = input.order === 'by-state' ? 'by-state' : 'spread';
  const states = Array.isArray(input.states)
    ? [
        ...new Set(
          input.states
            .map((s) => normalizeStateCode(typeof s === 'string' ? s : null))
            .filter((s): s is string => s !== null),
        ),
      ].sort()
    : [];
  // "Only these states" with none chosen would stop everything; treat it as
  // no restriction rather than as an instruction to search nothing.
  return { order, states, only: input.only === true && states.length > 0 };
}

/**
 * Compute every unstarted job's priority under a plan. Pure, so the ordering
 * can be tested without a database.
 */
export function computePriorities(
  jobs: readonly UnstartedJob[],
  cities: ReadonlyMap<number, CityRecord>,
  categories: ReadonlyMap<number, CategoryRecord>,
  finishedByState: ReadonlyMap<string, number>,
  plan: QueuePlan,
): Map<number, number> {
  const states = [...new Set(jobs.map((j) => j.stateCode))].sort();
  const stateIndex = new Map(states.map((s, i) => [s, i]));

  // Services in a fixed order, so the rotation is stable between runs.
  const categoryIds = [...new Set(jobs.map((j) => j.categoryId))].sort((a, b) =>
    (categories.get(a)?.name ?? '').localeCompare(categories.get(b)?.name ?? ''),
  );
  const categoryIndex = new Map(categoryIds.map((id, i) => [id, i]));
  const n = categoryIds.length;

  // Cities within each state: largest first when population is known, then by
  // name, so the order is deterministic either way.
  const citiesByState = new Map<string, number[]>();
  for (const job of jobs) {
    const list = citiesByState.get(job.stateCode) ?? [];
    if (!list.includes(job.cityId)) list.push(job.cityId);
    citiesByState.set(job.stateCode, list);
  }
  const cityIndex = new Map<number, number>();
  for (const list of citiesByState.values()) {
    list.sort((a, b) => {
      const ca = cities.get(a);
      const cb = cities.get(b);
      return (
        (cb?.population ?? -1) - (ca?.population ?? -1) ||
        (ca?.city ?? '').localeCompare(cb?.city ?? '') ||
        a - b
      );
    });
    list.forEach((id, i) => cityIndex.set(id, i));
  }

  const position = new Map<number, number>();
  if (plan.order === 'spread') {
    const stateCount = states.length;
    for (const job of jobs) {
      const s = stateIndex.get(job.stateCode)!;
      const i = cityIndex.get(job.cityId)!;
      const m = citiesByState.get(job.stateCode)!.length;
      const j = categoryIndex.get(job.categoryId)!;
      // Rotate the service by state and by city, so neighbouring searches in
      // the queue are for different services. For a fixed city, j -> r is a
      // bijection, so (r, i) — and hence `round` — is unique within a state.
      const r = (((j - s - i) % n) + n) % n;
      const round = r * m + i + (finishedByState.get(job.stateCode) ?? 0);
      position.set(job.id, round * stateCount + s);
    }
  } else {
    const sorted = [...jobs].sort(
      (a, b) =>
        stateIndex.get(a.stateCode)! - stateIndex.get(b.stateCode)! ||
        cityIndex.get(a.cityId)! - cityIndex.get(b.cityId)! ||
        categoryIndex.get(a.categoryId)! - categoryIndex.get(b.categoryId)!,
    );
    sorted.forEach((job, index) => position.set(job.id, index));
  }

  const focus = new Set(plan.states);
  const priorities = new Map<number, number>();
  for (const job of jobs) {
    const weight = Math.round((categories.get(job.categoryId)?.weight ?? 1) * 100);
    priorities.set(
      job.id,
      (focus.has(job.stateCode) ? FOCUS_BAND : 0) +
        weight * WEIGHT_BAND +
        (POSITION_SPAN - 1 - Math.min(position.get(job.id)!, POSITION_SPAN - 1)),
    );
  }
  return priorities;
}

export interface SyncResult {
  /** Jobs moved between `pending` and `paused`. */
  readonly statusChanged: number;
  /** Jobs whose place in the queue moved. */
  readonly reordered: number;
}

/**
 * Bring the queue in line with the stored plan and the seeds' active flags.
 *
 * Called after anything that changes what should run or in what order: a
 * plan, a seed edit, an import, a new queue plan, and the start of every
 * scrape. Cheap enough for that — ~16k rows read and only changed ones written.
 */
export function syncQueue(
  driver: SqliteDriver,
  plan: QueuePlan = readQueuePlan(driver),
): SyncResult {
  const seedJobs = new SeedJobsRepository(driver, AUTOMATION_ID);
  return driver.transaction(() => {
    const statusChanged = seedJobs.syncPaused(plan.only ? plan.states : null);
    const jobs = seedJobs.unstarted();
    if (jobs.length === 0) return { statusChanged, reordered: 0 };

    const cities = new Map(new CitiesRepository(driver).all(false).map((c) => [c.id, c]));
    const categories = new Map(new CategoriesRepository(driver).all(false).map((c) => [c.id, c]));
    // A job whose seed no longer exists keeps its priority rather than being
    // ordered against data that is not there.
    const known = jobs.filter((j) => cities.has(j.cityId) && categories.has(j.categoryId));
    const priorities = computePriorities(
      known,
      cities,
      categories,
      seedJobs.finishedByState(),
      plan,
    );
    return { statusChanged, reordered: seedJobs.setPriorities(priorities) };
  }, 'immediate');
}

/** Store a new plan and apply it straight away. */
export function setQueuePlan(
  driver: SqliteDriver,
  input: Partial<Record<keyof QueuePlan, unknown>>,
): { plan: QueuePlan } & SyncResult {
  const plan = normalizePlan(input);
  return driver.transaction(() => {
    new MetaRepository(driver).set(PLAN_KEY, JSON.stringify(plan));
    return { plan, ...syncQueue(driver, plan) };
  }, 'immediate');
}

export interface StateSummary {
  readonly code: string;
  readonly name: string;
  readonly cities: number;
  /** Searches finished in this state. */
  readonly done: number;
  /** Searches not yet run, paused ones included. */
  readonly remaining: number;
}

export interface QueueView {
  readonly plan: QueuePlan;
  readonly states: StateSummary[];
  readonly next: { city: string; stateCode: string; category: string }[];
}

/** What the dashboard shows: the plan, every state's numbers, and what runs next. */
export function queueView(driver: SqliteDriver, limit = 8): QueueView {
  const seedJobs = new SeedJobsRepository(driver, AUTOMATION_ID);
  const done = seedJobs.finishedByState();
  const remaining = new Map<string, number>();
  for (const job of seedJobs.unstarted()) {
    remaining.set(job.stateCode, (remaining.get(job.stateCode) ?? 0) + 1);
  }

  const byState = new Map<string, { name: string; cities: number }>();
  for (const city of new CitiesRepository(driver).all(false)) {
    const entry = byState.get(city.state_code) ?? { name: city.state, cities: 0 };
    entry.cities += 1;
    byState.set(city.state_code, entry);
  }

  return {
    plan: readQueuePlan(driver),
    states: [...byState.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, { name, cities }]) => ({
        code,
        name,
        cities,
        done: done.get(code) ?? 0,
        remaining: remaining.get(code) ?? 0,
      })),
    next: seedJobs.nextUp(limit),
  };
}
