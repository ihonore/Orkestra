/**
 * Autopilot's decisions, as scenarios: what it starts, and why it waits.
 *
 * {@link decide} is pure, so time, memory and the database are all inputs here
 * and nothing needs a browser or Google.
 */
import { describe, expect, it } from 'vitest';
import {
  Autopilot,
  DEFAULT_AUTOPILOT,
  FRESH_HISTORY,
  afterRun,
  decide,
  normalizeAutopilot,
  type DecideInput,
  type Snapshot,
} from '../src/ui/autopilot.js';
import type { Task, TaskManager, TaskName } from '../src/ui/tasks.js';

const NOW = 1_800_000_000_000;
const ON = { ...DEFAULT_AUTOPILOT, enabled: true };

function input(snapshot: Partial<Snapshot>, extra: Partial<DecideInput> = {}): DecideInput {
  return {
    settings: ON,
    snapshot: {
      searchesQueued: 0,
      sitesQueued: 0,
      rowsUnsent: 0,
      lastSentAt: null,
      sheetEntity: 'leads-by-business',
      rescrape: null,
      ...snapshot,
    },
    running: new Set<TaskName>(),
    history: FRESH_HISTORY,
    now: NOW,
    freeMemoryMb: 4_000,
    enabledAt: NOW,
    ...extra,
  };
}

const started = (d: ReturnType<typeof decide>) => d.start.map((s) => s.stage);

describe('autopilot decisions', () => {
  it('does nothing at all while off', () => {
    const d = decide(input({ searchesQueued: 100 }, { settings: DEFAULT_AUTOPILOT }));
    expect(d.start).toEqual([]);
    expect(d.status.scrape.state).toBe('off');
  });

  it('scrapes whenever searches are queued, with the configured workers', () => {
    const d = decide(input({ searchesQueued: 15_000 }));
    expect(d.start).toContainEqual({ stage: 'scrape', input: { workers: 4 } });
  });

  it('finds emails alongside the scrape once enough websites are waiting', () => {
    const scraping = new Set<TaskName>(['run']);
    expect(
      started(decide(input({ searchesQueued: 9, sitesQueued: 24 }, { running: scraping }))),
    ).toEqual([]);
    expect(
      started(decide(input({ searchesQueued: 9, sitesQueued: 25 }, { running: scraping }))),
    ).toEqual(['emails']);
  });

  it('crawls a short queue once nothing more is coming', () => {
    expect(started(decide(input({ searchesQueued: 0, sitesQueued: 3 })))).toEqual(['emails']);
  });

  it('sends to the sheet when a batch is full', () => {
    const busy = new Set<TaskName>(['run', 'enrich']);
    const d = decide(
      input({ searchesQueued: 9, sitesQueued: 9, rowsUnsent: 500 }, { running: busy }),
    );
    expect(d.start).toEqual([{ stage: 'sheets', input: { entity: 'leads-by-business' } }]);
  });

  it('holds a part batch, and says when it will go at the latest', () => {
    const busy = new Set<TaskName>(['run', 'enrich']);
    const d = decide(
      input(
        { searchesQueued: 9, sitesQueued: 9, rowsUnsent: 120, lastSentAt: NOW - 60_000 },
        { running: busy },
      ),
    );
    expect(d.start).toEqual([]);
    expect(d.status.sheets.detail).toMatch(
      /120 of 500 businesses with an email ready · sending by/,
    );
  });

  it('sends a part batch once it has waited long enough', () => {
    const busy = new Set<TaskName>(['run', 'enrich']);
    const d = decide(
      input(
        { searchesQueued: 9, sitesQueued: 9, rowsUnsent: 12, lastSentAt: NOW - 121 * 60_000 },
        { running: busy },
      ),
    );
    expect(started(d)).toEqual(['sheets']);
  });

  it('sends whatever is left once the whole pipeline has finished', () => {
    expect(started(decide(input({ rowsUnsent: 7, lastSentAt: NOW })))).toEqual(['sheets']);
  });

  it('sends whichever export the sheet layout names', () => {
    const d = decide(input({ rowsUnsent: 600, sheetEntity: 'leads-flat' }));
    expect(d.start).toContainEqual({ stage: 'sheets', input: { entity: 'leads-flat' } });
  });

  it('holds the sheet while a re-scrape is correcting the data, and says how far it has got', () => {
    const busy = new Set<TaskName>(['run', 'enrich']);
    const d = decide(
      input(
        { searchesQueued: 900, rowsUnsent: 5_000, rescrape: { total: 2_000, remaining: 700 } },
        { running: busy },
      ),
    );
    expect(started(d)).toEqual([]);
    expect(d.status.sheets.detail).toBe(
      'holding until the re-scrape finishes: 1,300 of 2,000 searches re-read',
    );
  });

  it('resumes sending once the re-scrape is done', () => {
    const d = decide(input({ rowsUnsent: 5_000, rescrape: null }));
    expect(started(d)).toContain('sheets');
  });

  it('says the sheet is not set up rather than failing every tick', () => {
    const d = decide(input({ rowsUnsent: null }));
    expect(d.start).toEqual([]);
    expect(d.status.sheets.detail).toMatch(/step 7/);
  });

  it('never starts a second copy of a running step', () => {
    const all = new Set<TaskName>(['run', 'enrich', 'export-sheets']);
    expect(
      decide(input({ searchesQueued: 9, sitesQueued: 900, rowsUnsent: 900 }, { running: all }))
        .start,
    ).toEqual([]);
  });

  it('starts nothing new while memory is short, and says why', () => {
    const d = decide(input({ searchesQueued: 9, sitesQueued: 900 }, { freeMemoryMb: 600 }));
    expect(d.start).toEqual([]);
    expect(d.status.scrape.detail).toMatch(/600 MB free, below the 1024 MB floor/);
  });

  it('backs off after a failure instead of relaunching every tick', () => {
    const failed = afterRun(FRESH_HISTORY.scrape, false, NOW, 'scrape');
    const history = { ...FRESH_HISTORY, scrape: failed };
    expect(started(decide(input({ searchesQueued: 9 }, { history })))).toEqual([]);
    expect(decide(input({ searchesQueued: 9 }, { history })).status.scrape.detail).toMatch(
      /failed; retrying in 2 min/,
    );
    expect(
      started(decide(input({ searchesQueued: 9 }, { history, now: NOW + 2 * 60_000 }))),
    ).toEqual(['scrape']);
  });

  it('doubles the backoff with each failure in a row, up to an hour', () => {
    let h = FRESH_HISTORY.emails;
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      h = afterRun(h, false, NOW, 'emails');
      waits.push((h.notBefore - NOW) / 60_000);
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(afterRun(h, true, NOW, 'emails')).toEqual({ failures: 0, notBefore: NOW + 60_000 });
  });

  it('waits a moment before rescraping, so a queue in retry backoff is not hammered', () => {
    const history = {
      ...FRESH_HISTORY,
      scrape: afterRun(FRESH_HISTORY.scrape, true, NOW, 'scrape'),
    };
    expect(started(decide(input({ searchesQueued: 9 }, { history })))).toEqual([]);
  });
});

describe('autopilot settings', () => {
  it('defaults to the settings sized for the VPS, switched off', () => {
    expect(normalizeAutopilot({})).toEqual(DEFAULT_AUTOPILOT);
    expect(DEFAULT_AUTOPILOT).toMatchObject({
      enabled: false,
      scrape: { workers: 4 },
      emails: { workers: 8, minSites: 25 },
      sheets: { batchRows: 500, maxWaitMinutes: 120 },
      minFreeMemoryMb: 1024,
    });
  });

  it('clamps rather than rejects, like the task buttons', () => {
    const s = normalizeAutopilot({
      scrape: { workers: 500 },
      emails: { workers: 0, minSites: 'lots' },
      sheets: { batchRows: 3 },
      minFreeMemoryMb: -5,
    });
    expect(s.scrape.workers).toBe(8);
    expect(s.emails.workers).toBe(1);
    expect(s.emails.minSites).toBe(DEFAULT_AUTOPILOT.emails.minSites);
    expect(s.sheets.batchRows).toBe(50);
    expect(s.minFreeMemoryMb).toBe(256);
  });
});

describe('the autopilot controller', () => {
  /** A controller over fake tasks, a fake clock and a fake database. */
  function rig(snapshot: Partial<Snapshot> = {}) {
    let now = NOW;
    let saved: unknown = null;
    const tasks = new Map<
      string,
      { id: string; name: TaskName; state: string; finishedAt: number | null }
    >();
    const startedNames: TaskName[] = [];
    const pilot = new Autopilot({
      load: () => normalizeAutopilot({}),
      save: (s) => {
        saved = s;
      },
      snapshot: () => ({
        searchesQueued: 100,
        sitesQueued: 0,
        rowsUnsent: 0,
        lastSentAt: null,
        sheetEntity: 'leads-by-business',
        rescrape: null,
        ...snapshot,
      }),
      tasks: {
        get: (id: string) => tasks.get(id),
        list: () => [...tasks.values()],
      } as unknown as TaskManager,
      start: (name) => {
        const task = { id: `t${tasks.size}`, name, state: 'running', finishedAt: null };
        tasks.set(task.id, task);
        startedNames.push(name);
        return { ok: true, task: task as unknown as Task };
      },
      freeMemoryMb: () => 4_000,
      now: () => now,
    });
    return {
      pilot,
      tasks,
      startedNames,
      saved: () => saved,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('starts what is due as soon as it is turned on, and persists the switch', () => {
    const r = rig();
    r.pilot.update({ enabled: true });
    expect(r.startedNames).toEqual(['run']);
    expect(r.saved()).toMatchObject({ enabled: true });
  });

  it('does not start a second scrape while the first runs', () => {
    const r = rig();
    r.pilot.update({ enabled: true });
    r.pilot.tick();
    r.pilot.tick();
    expect(r.startedNames).toEqual(['run']);
  });

  it('waits after a failed run, then tries again', () => {
    const r = rig();
    r.pilot.update({ enabled: true });
    const first = [...r.tasks.values()][0]!;
    first.state = 'failed';
    first.finishedAt = NOW;

    r.pilot.tick();
    expect(r.startedNames).toEqual(['run']);
    expect(r.pilot.view().status.scrape.detail).toMatch(/retrying/);

    r.advance(2 * 60_000);
    r.pilot.tick();
    expect(r.startedNames).toEqual(['run', 'run']);
  });

  it('turns itself off when someone stops a step by hand, and says so', () => {
    const r = rig();
    r.pilot.update({ enabled: true });
    r.pilot.standDown('you stopped it');
    expect(r.saved()).toMatchObject({ enabled: false });
    expect(r.pilot.view().note).toBe('you stopped it');

    const first = [...r.tasks.values()][0]!;
    first.state = 'stopped';
    r.pilot.tick();
    expect(r.startedNames).toEqual(['run']);
  });
});
