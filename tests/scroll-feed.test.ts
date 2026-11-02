/**
 * The Maps feed scroll, against a real browser and a feed that behaves like
 * Google's: 20 results at a time, the next 20 fetched only once the list is
 * scrolled to its bottom, and an end-of-list line when there are no more.
 *
 * Measured on real runs before the fix: of 111 searches that stopped on
 * "stagnation", the median had found exactly 20 — the first batch — while
 * searches that reached the end of the list had a median of 107. Idle rounds
 * were being counted while still scrolling through the first batch, so the
 * search gave up before it ever reached the bottom that triggers the next one.
 */
import fs from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scrollFeed } from '../src/automations/google-maps/search.js';

const hasChromium = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

/** A results feed: `total` places, `batch` at a time, each batch `delayMs` after reaching the bottom. */
function feedPage(total: number, batch = 20, delayMs = 600): string {
  return `<!doctype html><html><body style="margin:0">
  <div role="feed" style="height:700px;overflow-y:auto">
  </div>
  <script>
    const feed = document.querySelector('[role=feed]');
    let shown = 0, loading = false, ended = false;
    function add(n) {
      for (let i = 0; i < n && shown < ${total}; i++, shown++) {
        const a = document.createElement('a');
        a.href = 'https://www.google.com/maps/place/Biz+' + shown + '/data=!4m7!3m6!1s0x88:0x' + (1000 + shown).toString(16) + '!8m2!3d1!4d2';
        a.textContent = 'Business ' + shown;
        a.style = 'display:block;height:120px';
        feed.appendChild(a);
      }
    }
    add(${batch});
    feed.addEventListener('scroll', () => {
      const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4;
      if (!atBottom || loading || ended) return;
      if (shown >= ${total}) {
        ended = true;
        const p = document.createElement('p');
        p.textContent = "You've reached the end of the list.";
        feed.appendChild(p);
        return;
      }
      loading = true;
      setTimeout(() => { add(${batch}); loading = false; }, ${delayMs});
    });
  </script></body></html>`;
}

describe.skipIf(!hasChromium)('scrolling the results feed', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** `fast` shortens the pauses, for cases that do not depend on real timing. */
  async function harvest(total: number, delayMs?: number, fast = false) {
    const page = await browser.newPage();
    try {
      await page.setContent(feedPage(total, 20, fast ? 150 : delayMs));
      return await scrollFeed(page, {
        timeBudgetMs: 60_000,
        // Otherwise the real defaults, so the test measures what a run does.
        ...(fast && {
          pauseMs: [40, 80] as [number, number],
          loadWaitMs: [300, 400] as [number, number],
        }),
      });
    } finally {
      await page.close();
    }
  }

  it('gets past the first batch of 20 to the end of a long list', async () => {
    const result = await harvest(65);
    expect(result.urls).toHaveLength(65);
    expect(result.reason).toBe('end-of-list');
  }, 90_000);

  it('waits for a slow connection that takes 2.5 s per batch', async () => {
    const result = await harvest(45, 2_500);
    expect(result.urls).toHaveLength(45);
    expect(result.reason).toBe('end-of-list');
  }, 90_000);

  it('still stops at the 120-listing cap', async () => {
    const result = await harvest(200, undefined, true);
    expect(result.urls).toHaveLength(120);
    expect(result.reason).toBe('max-listings');
  }, 120_000);

  it('finishes promptly on a short list that never scrolls', async () => {
    const started = Date.now();
    const result = await harvest(6, undefined, true);
    expect(result.urls).toHaveLength(6);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
