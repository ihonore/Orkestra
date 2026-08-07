/**
 * Human-ish pacing.
 *
 * Two rules, both learned from the legacy flow's failures:
 *
 *  1. **Never a fixed wait.** The old automation used fixed 15–30s
 *     `waitForTimeout` calls, which is both slower than necessary and a clean
 *     automation signal. Always wait on a *condition* with a timeout ceiling.
 *
 *  2. **Jitter is log-normal, not uniform.** Human inter-action times cluster
 *     around a mode with a long right tail — mostly quick, occasionally much
 *     slower. Uniform noise has a flat distribution and a hard ceiling, which is
 *     itself a fingerprint.
 */

/** An inclusive `[min, max]` millisecond range. */
export type Range = readonly [number, number];

export interface JitterOptions {
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
}

/**
 * Two independent uniforms transformed into one standard normal.
 *
 * Box–Muller. `1 - random()` avoids log(0) when random() returns exactly 0.
 */
function standardNormal(random: () => number): number {
  const u1 = 1 - random();
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A log-normally distributed delay within `[min, max]`.
 *
 * The distribution is centred on the geometric mean of the range, so most draws
 * land in the lower-middle with an occasional long pause — the shape of a person
 * reading a page rather than a timer firing.
 */
export function jitter(range: Range, options: JitterOptions = {}): number {
  const [min, max] = range;
  if (!(max > min)) return Math.max(0, min);

  const random = options.random ?? Math.random;
  const logMin = Math.log(Math.max(1, min));
  const logMax = Math.log(max);
  const mu = (logMin + logMax) / 2;
  // ~99.7% of a normal lies within 3 sigma, so this keeps most draws in range
  // before the clamp does anything.
  const sigma = (logMax - logMin) / 6;

  const value = Math.exp(mu + sigma * standardNormal(random));
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Sleep for a jittered duration, resolving early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Sleep for a log-normal duration drawn from `range`. */
export function humanPause(
  range: Range,
  options: JitterOptions & { signal?: AbortSignal } = {},
): Promise<void> {
  return sleep(jitter(range, options), options.signal);
}

/**
 * A plausible desktop viewport.
 *
 * Randomized within a band real monitors actually occupy. A viewport nobody has
 * is as identifying as a constant one, so this is not uniform noise over a wide
 * range — it jitters around common sizes.
 */
export function randomViewport(options: JitterOptions = {}): { width: number; height: number } {
  const random = options.random ?? Math.random;
  const bases: readonly (readonly [number, number])[] = [
    [1920, 1080],
    [1536, 864],
    [1440, 900],
    [1366, 768],
    [1680, 1050],
  ];
  const base = bases[Math.floor(random() * bases.length)] ?? bases[0]!;
  // A few pixels of slop, as browser chrome and OS scaling produce in practice.
  const width = base[0] - Math.floor(random() * 40);
  const height = base[1] - Math.floor(random() * 120);
  return { width, height };
}

/**
 * Scroll deltas for one wheel gesture.
 *
 * Real wheel scrolling arrives as a burst of similar-but-not-identical deltas,
 * not one large jump.
 */
export function scrollBurst(
  stepRange: Range,
  count: number,
  options: JitterOptions = {},
): number[] {
  return Array.from({ length: Math.max(1, count) }, () => jitter(stepRange, options));
}
