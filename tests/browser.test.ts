import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrency, detectBlock } from '../src/core/browser/block-detector.js';
import { consentCacheKey, isConsentUrl } from '../src/core/browser/consent.js';
import { jitter, randomViewport, scrollBurst } from '../src/core/browser/humanize.js';
import { ShutdownController } from '../src/core/engine/shutdown.js';

describe('block detection', () => {
  it('flags the /sorry block page', () => {
    const verdict = detectBlock({ url: 'https://www.google.com/sorry/index?continue=x' });
    expect(verdict.blocked).toBe(true);
    expect(verdict.signals).toContain('sorry-redirect');
  });

  it('flags rate limiting and forbidden', () => {
    expect(detectBlock({ url: 'https://maps.google.com', status: 429 }).signals).toContain(
      'http-429',
    );
    expect(detectBlock({ url: 'https://maps.google.com', status: 403 }).signals).toContain(
      'http-403',
    );
  });

  it('recognises the unusual-traffic interstitial by its text', () => {
    const verdict = detectBlock({
      url: 'https://www.google.com/search',
      status: 200,
      bodyText: 'Our systems have detected unusual traffic from your computer network.',
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.signals).toContain('unusual-traffic');
  });

  it('recognises a captcha', () => {
    expect(
      detectBlock({ url: 'https://x', bodyText: 'Please verify you are a human' }).signals,
    ).toContain('captcha');
  });

  it('treats a repeating consent screen as a block', () => {
    expect(detectBlock({ url: 'https://maps.google.com', consentAttempts: 2 }).signals).toContain(
      'consent-loop',
    );
  });

  it('does not flag a normal page', () => {
    const verdict = detectBlock({
      url: 'https://www.google.com/maps/search/plumber',
      status: 200,
      bodyText: 'Results for plumber',
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it('does not treat an empty result set as a block on its own', () => {
    // An obscure category in a small town legitimately returns nothing. Calling
    // that a block would burn a good proxy and requeue work forever.
    const verdict = detectBlock({
      url: 'https://www.google.com/maps/search/x',
      status: 200,
      bodyText: 'No results found',
      emptyResults: true,
    });
    expect(verdict.blocked).toBe(false);
  });

  it('explains itself, so the reason lands in the job record', () => {
    const verdict = detectBlock({ url: 'https://www.google.com/sorry/index', status: 429 });
    expect(verdict.reason).toMatch(/block page/);
    expect(verdict.reason).toMatch(/429/);
  });
});

describe('adaptive concurrency', () => {
  it('creeps upward while jobs are clean', () => {
    const aimd = new AdaptiveConcurrency({ min: 1, max: 8, start: 1, blockRateThreshold: 0.2 });
    for (let i = 0; i < 10; i += 1) aimd.record(false);
    expect(aimd.current).toBeGreaterThan(1);
    expect(aimd.current).toBeLessThanOrEqual(8);
  });

  it('never exceeds the configured maximum', () => {
    const aimd = new AdaptiveConcurrency({ min: 1, max: 3, start: 1, blockRateThreshold: 0.5 });
    for (let i = 0; i < 50; i += 1) aimd.record(false);
    expect(aimd.current).toBe(3);
  });

  it('halves when the block rate crosses the threshold', () => {
    const aimd = new AdaptiveConcurrency({ min: 1, max: 16, start: 8, blockRateThreshold: 0.2 });
    for (let i = 0; i < 5; i += 1) aimd.record(true);
    expect(aimd.current).toBeLessThan(8);
  });

  it('does not react to a single unlucky block', () => {
    // Halving a healthy fleet because of one request would stall the run.
    const aimd = new AdaptiveConcurrency({ min: 1, max: 16, start: 8, blockRateThreshold: 0.2 });
    aimd.record(true);
    expect(aimd.current).toBe(8);
  });

  it('never drops below the configured minimum', () => {
    const aimd = new AdaptiveConcurrency({ min: 2, max: 16, start: 4, blockRateThreshold: 0.1 });
    for (let i = 0; i < 100; i += 1) aimd.record(true);
    expect(aimd.current).toBe(2);
  });
});

describe('humanized pacing', () => {
  it('stays within the requested range', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = jitter([300, 900]);
      expect(value).toBeGreaterThanOrEqual(300);
      expect(value).toBeLessThanOrEqual(900);
    }
  });

  it('produces a spread of values, not a constant', () => {
    const values = new Set(Array.from({ length: 200 }, () => jitter([100, 5_000])));
    expect(values.size).toBeGreaterThan(50);
  });

  it('skews low with a long tail, the shape of human pauses', () => {
    const values = Array.from({ length: 3_000 }, () => jitter([100, 10_000]));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    // Log-normal: mean sits above median because of the right tail. Uniform
    // noise would put them together in the middle of the range.
    expect(median).toBeLessThan(mean);
    expect(median).toBeLessThan(5_050);
  });

  it('handles a degenerate range', () => {
    expect(jitter([500, 500])).toBe(500);
  });

  it('produces plausible desktop viewports', () => {
    for (let i = 0; i < 100; i += 1) {
      const { width, height } = randomViewport();
      expect(width).toBeGreaterThan(1_300);
      expect(width).toBeLessThanOrEqual(1_920);
      expect(height).toBeGreaterThan(600);
      expect(height).toBeLessThanOrEqual(1_080);
    }
  });

  it('varies scroll deltas within a burst', () => {
    const burst = scrollBurst([300, 900], 8);
    expect(burst).toHaveLength(8);
    expect(new Set(burst).size).toBeGreaterThan(1);
  });
});

describe('consent', () => {
  it('recognises consent URLs', () => {
    expect(isConsentUrl('https://consent.google.com/ml?continue=x')).toBe(true);
    expect(isConsentUrl('https://www.google.com/consent?x=1')).toBe(true);
    expect(isConsentUrl('https://www.google.com/maps/search/x')).toBe(false);
  });

  it('keys cached state by exit country as well as proxy', () => {
    // The cookie is per registrable domain, but the wall is triggered by IP
    // geolocation — state cleared from a US exit is not valid from a DE one.
    expect(consentCacheKey('p1', 'US')).not.toBe(consentCacheKey('p1', 'DE'));
    expect(consentCacheKey('p1', 'US')).not.toBe(consentCacheKey('p2', 'US'));
  });
});

describe('shutdown', () => {
  it('runs cleanup in reverse registration order', async () => {
    const order: string[] = [];
    const controller = new ShutdownController({ graceSeconds: 5, exit: () => undefined });
    controller.onShutdown('first', () => {
      order.push('first');
    });
    controller.onShutdown('second', () => {
      order.push('second');
    });

    await controller.shutdown('manual');
    expect(order).toEqual(['second', 'first']);
  });

  it('aborts its signal so in-flight work can stop early', async () => {
    const controller = new ShutdownController({ graceSeconds: 5, exit: () => undefined });
    expect(controller.signal.aborted).toBe(false);
    await controller.shutdown('SIGTERM');
    expect(controller.signal.aborted).toBe(true);
  });

  it('continues cleanup even when a task throws', async () => {
    const done: string[] = [];
    const controller = new ShutdownController({ graceSeconds: 5, exit: () => undefined });
    controller.onShutdown('ok', () => {
      done.push('ok');
    });
    controller.onShutdown('bad', () => {
      throw new Error('boom');
    });

    await controller.shutdown('manual');
    expect(done).toEqual(['ok']);
    expect(controller.completed).toBe(true);
  });

  it('escalates to exit on a second signal', async () => {
    let exitCode: number | null = null;
    const controller = new ShutdownController({
      graceSeconds: 5,
      exit: (code) => {
        exitCode = code;
      },
    });
    controller.onShutdown('slow', () => new Promise((r) => setTimeout(r, 50)));

    const first = controller.shutdown('SIGINT');
    await controller.shutdown('SIGINT');
    await first;

    expect(exitCode).toBe(130);
  });

  it('gives up after the grace period rather than hanging forever', async () => {
    const controller = new ShutdownController({ graceSeconds: 0.05, exit: () => undefined });
    controller.onShutdown('never', () => new Promise(() => undefined));

    await controller.shutdown('manual');
    expect(controller.completed).toBe(true);
  });

  it('registers SIGBREAK, which Playwright does not handle', () => {
    // Without it, Ctrl+Break on Windows orphans the whole Chromium tree.
    const controller = new ShutdownController({ exit: () => undefined });
    const before = process.listenerCount('SIGBREAK');
    controller.install();
    expect(process.listenerCount('SIGBREAK')).toBe(before + 1);
    controller.uninstall();
    expect(process.listenerCount('SIGBREAK')).toBe(before);
  });
});
