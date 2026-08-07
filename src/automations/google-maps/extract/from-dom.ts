/**
 * The DOM extraction channel.
 *
 * Selectors here are `data-item-id` literals and ARIA roles, never the hashed
 * class names (`DUwDvf`, `Nv2PK`, `qBF1Pd`) the legacy flow depended on. Those
 * tokens are compiler-generated and rotate; `data-item-id` values are hardcoded
 * in Google's own source and have been stable for years.
 *
 * Two specific traps this avoids:
 *
 *  - **Never a bare `h1`.** The results feed stays in the DOM behind the open
 *    place panel, and both emit an `h1`. `page.locator('h1')` therefore matches
 *    several nodes and can attribute one business's name to another's record —
 *    a corruption that looks like perfectly valid data.
 *
 *  - **The phone number is in the attribute, not the text.**
 *    `data-item-id="phone:tel:+12052021320"` is already normalized; the visible
 *    text is the formatted version and varies.
 */
/* eslint-disable no-restricted-globals --
   Every page.evaluate() body in this file is serialized and executed inside
   the browser, where `document` and `getComputedStyle` are the correct
   globals. Nothing here runs in Node except the thin async wrappers. */
import type { Page } from 'playwright';

/** Raw strings from the DOM. Normalization happens later, in one place. */
export interface DomExtraction {
  readonly name: string | null;
  readonly categoryPrimary: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly rating: string | null;
  readonly reviews: string | null;
  readonly plusCode: string | null;
  readonly hours: string | null;
  readonly thumbnail: string | null;
  readonly permanentlyClosed: boolean;
}

/**
 * The place panel, scoped so the feed behind it cannot be read by mistake.
 *
 * `div[role="main"]` carries an `aria-label` equal to the business name, which
 * is both the safest name source and the scope for every other field.
 */
const PANEL = 'div[role="main"][aria-label]';

export async function extractFromDom(page: Page): Promise<DomExtraction> {
  // One evaluate rather than a dozen locator round-trips: each round-trip is a
  // CDP message, and this runs once per listing across ~940k listings.
  //
  return page.evaluate((panelSelector: string) => {
    const panel = document.querySelector(panelSelector);
    const root: ParentNode = panel ?? document;

    const text = (selector: string): string | null => {
      const el = root.querySelector(selector);
      const value = el?.textContent?.trim();
      return value === undefined || value === '' ? null : value;
    };

    const attr = (selector: string, name: string): string | null => {
      const value = root.querySelector(selector)?.getAttribute(name);
      return value === null || value === undefined || value === '' ? null : value;
    };

    // Name from the panel's aria-label, never a bare h1.
    const name = panel?.getAttribute('aria-label')?.trim() ?? null;

    // data-item-id="phone:tel:+1..." — parse the attribute, not the text.
    const phoneNode = root.querySelector('[data-item-id^="phone:tel:"]');
    const phone = phoneNode?.getAttribute('data-item-id')?.replace('phone:tel:', '') ?? null;

    // The website row is data-item-id="authority"; its href is the real target
    // (Maps has already unwrapped it) but it can also be a /url? redirect.
    const websiteNode = root.querySelector('[data-item-id="authority"]');
    const website = websiteNode?.getAttribute('href') ?? websiteNode?.textContent?.trim() ?? null;

    // Rating and review count live in aria-labels. Text matching only works
    // because every URL pins hl=en; under another locale these are translated.
    //
    // Several elements carry a "star" label and the first is often the empty
    // placeholder " stars" — taking `querySelector` alone yields null ratings
    // for every listing. Pick the first label that actually contains a number.
    const ratingLabel =
      [...root.querySelectorAll('[aria-label*="star"]')]
        .map((el) => el.getAttribute('aria-label'))
        .find((label) => label !== null && /\d/.test(label)) ?? null;

    const reviewsLabel =
      [...root.querySelectorAll('[aria-label*="review"]')]
        .map((el) => el.getAttribute('aria-label'))
        .find((label) => label !== null && /\d/.test(label)) ??
      root.querySelector('button[jsaction*="reviewChart"]')?.textContent ??
      null;

    const closedText = root.textContent ?? '';

    return {
      name,
      categoryPrimary: text('button[jsaction*="category"]') ?? text('[jsaction*="category"]'),
      address:
        attr('[data-item-id="address"]', 'aria-label')?.replace(/^Address:\s*/i, '') ??
        text('[data-item-id="address"]'),
      phone,
      website,
      rating: ratingLabel,
      reviews: reviewsLabel,
      plusCode:
        attr('[data-item-id^="oloc"]', 'aria-label')?.replace(/^Plus code:\s*/i, '') ??
        text('[data-item-id^="oloc"]'),
      hours: text('[data-item-id^="oh"]'),
      thumbnail:
        attr('button[jsaction*="heroHeaderImage"] img', 'src') ?? attr('img[decoding]', 'src'),
      permanentlyClosed: /permanently closed/i.test(closedText),
    };
  }, PANEL);
}

/**
 * Place links currently rendered in the results feed, in order.
 *
 * `a[href*="/maps/place/"]` is a structural match on the href, which survives
 * every class-name change. Order matters: it is the result rank.
 */
export async function feedPlaceLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/maps/place/"]')]
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => href !== ''),
  );
}

/**
 * Locate the scrollable results container.
 *
 * Prefers `div[role="feed"]`. When that is absent — Google has changed this
 * before — it walks up from the first place link to the nearest ancestor that
 * actually scrolls. That fallback is what lets one class of DOM change happen
 * without a code deploy.
 *
 * Returns a selector string usable from Node, or null when there is no feed.
 */
export async function findFeedSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (feed !== null) return 'div[role="feed"]';

    const link = document.querySelector('a[href*="/maps/place/"]');
    if (link === null) return null;

    let node: HTMLElement | null = link.parentElement;
    while (node !== null && node !== document.body) {
      const style = getComputedStyle(node);
      const scrolls =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 50;
      if (scrolls) {
        // Tag it so Node can address this exact element afterwards.
        node.setAttribute('data-gms-feed', '1');
        return '[data-gms-feed="1"]';
      }
      node = node.parentElement;
    }
    return null;
  });
}

/**
 * Whether the feed has reached its end.
 *
 * Google renders a sentinel block at the bottom of a completed list. This is a
 * *secondary* signal only — no stable structure for it could be verified, and
 * the text is English-only — so scroll termination is driven by count
 * stagnation, with this as a fast path.
 */
export async function hasEndOfList(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    // Text only. An earlier version also checked `span.HlvSq`, which is a
    // compiler-generated class name of exactly the kind this module exists to
    // avoid — it rotates, and when it does it fails closed and silently. It
    // added nothing the text checks do not already cover, and scroll
    // termination does not depend on this function anyway: count stagnation is
    // the primary signal and this is only a fast path.
    return /You['’]ve reached the end of the list/i.test(text) || /No more results/i.test(text);
  });
}
