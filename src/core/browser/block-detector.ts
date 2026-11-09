/**
 * Block detection.
 *
 * Being blocked is not an error to retry blindly — it is a statement about the
 * current identity. Detecting it accurately is what separates "rotate the proxy
 * and back off" from "hammer the same burned IP until the job budget is gone".
 *
 * Detection is deliberately signal-based rather than a single check, because
 * Google expresses refusal in several ways and only some of them are HTTP
 * errors. A page that returns 200 with an empty feed is still a block.
 */

export type BlockSignal =
  | 'sorry-redirect'
  | 'captcha'
  | 'http-429'
  | 'http-403'
  | 'consent-loop'
  | 'blank-page'
  | 'unusual-traffic';

export interface BlockVerdict {
  readonly blocked: boolean;
  readonly signals: BlockSignal[];
  /** One-line explanation for the log and the job's `last_error`. */
  readonly reason: string | null;
}

export interface BlockInput {
  /** Final URL after redirects. */
  readonly url: string;
  readonly status?: number | null;
  /** Visible text. Only a prefix is needed; matching is on well-known phrases. */
  readonly bodyText?: string | null;
  /** Whether the page produced any results when results were expected. */
  readonly emptyResults?: boolean;
  /** How many times consent has been handled for this identity already. */
  readonly consentAttempts?: number;
}

/**
 * Phrases Google serves on its interstitials.
 *
 * Every Maps URL pins `hl=en`, so these are English first. The French forms
 * are here because Google has served a localised page to an English request
 * before, and a block that goes unrecognised is retried as an ordinary
 * failure instead of resting the identity.
 */
const BLOCK_PHRASES: readonly (readonly [RegExp, BlockSignal])[] = [
  [/unusual traffic from your computer network/i, 'unusual-traffic'],
  [/our systems have detected unusual traffic/i, 'unusual-traffic'],
  [/verify you.{0,3}re (not )?a (human|robot)/i, 'captcha'],
  [/i'?m not a robot/i, 'captcha'],
  [/recaptcha/i, 'captcha'],
  [/why did this happen\?/i, 'unusual-traffic'],
  [/nos syst[eè]mes ont d[ée]tect[ée] un trafic exceptionnel/i, 'unusual-traffic'],
  [/je ne suis pas un robot/i, 'captcha'],
  [/pourquoi cette page s'affiche/i, 'unusual-traffic'],
];

/** URL shapes that mean "refused" regardless of status code. */
function urlSignals(url: string): BlockSignal[] {
  const signals: BlockSignal[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return signals;
  }

  // google.com/sorry/index is the canonical block page.
  if (/\/sorry\/?/i.test(parsed.pathname)) signals.push('sorry-redirect');
  if (parsed.hostname.startsWith('ipv4.google.com') && parsed.pathname.includes('sorry')) {
    signals.push('sorry-redirect');
  }
  return signals;
}

/**
 * Classify a page as blocked or not.
 *
 * Pure, so it can be unit-tested against captured pages without a browser.
 */
export function detectBlock(input: BlockInput): BlockVerdict {
  const signals = new Set<BlockSignal>(urlSignals(input.url));

  if (input.status === 429) signals.add('http-429');
  if (input.status === 403) signals.add('http-403');

  const text = input.bodyText ?? '';
  for (const [pattern, signal] of BLOCK_PHRASES) {
    if (pattern.test(text)) signals.add(signal);
  }

  // A consent screen that keeps reappearing means the cookie is not sticking,
  // which in practice means this identity is being singled out.
  if ((input.consentAttempts ?? 0) >= 2) signals.add('consent-loop');

  // about:blank after a navigation that should have loaded something. On its
  // own this is weak, so it only counts when the page is genuinely empty.
  if (
    (input.url === 'about:blank' || input.url === '') &&
    (input.bodyText === null || text.trim() === '')
  ) {
    signals.add('blank-page');
  }

  const list = [...signals];
  if (list.length === 0) {
    // Deliberately NOT a block on its own: a genuinely empty result set is
    // normal for an obscure category in a small town. The caller decides,
    // using whether sibling queries are succeeding.
    return { blocked: false, signals: [], reason: null };
  }

  return { blocked: true, signals: list, reason: describe(list) };
}

function describe(signals: readonly BlockSignal[]): string {
  const parts: Record<BlockSignal, string> = {
    'sorry-redirect': 'redirected to Google’s block page (/sorry)',
    captcha: 'a CAPTCHA was presented',
    'http-429': 'HTTP 429 rate limited',
    'http-403': 'HTTP 403 forbidden',
    'consent-loop': 'the consent screen kept reappearing',
    'blank-page': 'the page loaded blank',
    'unusual-traffic': 'Google reported unusual traffic from this network',
  };
  return signals.map((s) => parts[s]).join('; ');
}

/**
 * Additive-increase / multiplicative-decrease concurrency control.
 *
 * Blocks arrive in bursts, so a fixed worker count is either too timid most of
 * the time or too aggressive at the wrong moment. AIMD backs off hard the moment
 * the block rate crosses the threshold and then creeps back up, which is the
 * same shape TCP uses for congestion and for the same reason.
 */
export class AdaptiveConcurrency {
  #current: number;

  constructor(
    private readonly options: {
      readonly min: number;
      readonly max: number;
      readonly start?: number;
      /** Block rate above which concurrency is halved. */
      readonly blockRateThreshold: number;
      /** Outcomes to consider when computing the rate. */
      readonly window?: number;
    },
  ) {
    this.#current = Math.min(options.max, Math.max(options.min, options.start ?? options.min));
  }

  readonly #outcomes: boolean[] = [];

  get current(): number {
    return this.#current;
  }

  get blockRate(): number {
    if (this.#outcomes.length === 0) return 0;
    return this.#outcomes.filter(Boolean).length / this.#outcomes.length;
  }

  /** Record one job outcome and return the concurrency to use next. */
  record(blocked: boolean): number {
    const window = this.options.window ?? 20;
    this.#outcomes.push(blocked);
    while (this.#outcomes.length > window) this.#outcomes.shift();

    // Wait for a meaningful sample: halving on the first block of a run would
    // stall a healthy fleet because of one unlucky request.
    if (this.#outcomes.length < Math.min(window, 5)) return this.#current;

    if (this.blockRate >= this.options.blockRateThreshold) {
      this.#current = Math.max(this.options.min, Math.floor(this.#current / 2));
      // Start the measurement afresh, or the same bad window would keep
      // triggering decreases while the new, lower rate takes effect.
      this.#outcomes.length = 0;
    } else if (!blocked) {
      this.#current = Math.min(this.options.max, this.#current + 1);
    }

    return this.#current;
  }
}
