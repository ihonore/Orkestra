/**
 * Email validation and junk rules.
 *
 * Every rule here exists because of something in the legacy output, not because
 * it seemed prudent. Of 597 addresses that system collected:
 *
 *  - **165 (28%) were institutional** — 67 from cau.edu, 41 gsu.edu, 20 ua.edu,
 *    18 gatech.edu. Four university directories produced a quarter of the whole
 *    dataset.
 *  - Sentry DSNs (`605a7bae…@sentry-next.wixpress.com`) were stored as contacts.
 *  - Image filenames (`insurance_logos@2x.jpg`) matched a naive email regex.
 *  - `u003Eprivacy@gatech.edu` — an HTML-escaped `>` welded onto an address,
 *    from regexing raw innerHTML instead of text.
 *  - `domain.com` appeared 9 times: a template placeholder.
 *
 * Rules run in order and the first match wins, so the reason recorded is the
 * most specific one. Rejects are stored rather than dropped: a rule that is too
 * aggressive is invisible unless you can see what it removed.
 */
import { parse } from 'tldts';

export type JunkReason =
  | 'syntax'
  | 'invalid_tld'
  | 'asset_extension'
  | 'inside_url'
  | 'vendor_telemetry'
  | 'placeholder'
  | 'non_contact'
  | 'hash_local_part'
  | 'filename_local_part'
  | 'government'
  | 'education'
  | 'no_mx';

export interface EmailVerdict {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
  readonly isJunk: boolean;
  readonly junkReason: JunkReason | null;
  readonly isRole: boolean;
  readonly isFree: boolean;
}

export interface ValidationOptions {
  /**
   * Reject `.gov`, `.mil` and state/local government domains.
   *
   * Government bodies are not sales prospects, and unsolicited commercial mail
   * to them is at best ignored.
   */
  readonly excludeGovernment?: boolean;
  /**
   * Reject `.edu` and school domains.
   *
   * Separate from government because it is a separate decision, but on by
   * default: university directories were the single largest junk source in the
   * legacy data, and a departmental address is not a lead.
   */
  readonly excludeEducation?: boolean;
  /** Extra domains to reject outright. */
  readonly blockedDomains?: readonly string[];
}

/** Role accounts. Kept, but flagged — they convert worse than a named person. */
const ROLE_LOCAL_PARTS = new Set([
  'info',
  'contact',
  'sales',
  'support',
  'admin',
  'office',
  'hello',
  'help',
  'enquiries',
  'inquiries',
  'service',
  'team',
  'mail',
  'general',
  'billing',
  'accounts',
  'careers',
  'jobs',
  'hr',
  'press',
  'media',
  'marketing',
  'webmaster',
  'postmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'privacy',
  'legal',
  'abuse',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
]);

/**
 * Telemetry and vendor domains that appear in page source but are never a
 * business contact.
 */
const VENDOR_DOMAINS: readonly RegExp[] = [
  /(^|\.)sentry\.io$/i,
  /(^|\.)sentry-next\.wixpress\.com$/i,
  /(^|\.)wixpress\.com$/i,
  /(^|\.)ingest\.sentry\.io$/i,
  /(^|\.)bugsnag\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)datadoghq\.com$/i,
  /(^|\.)rollbar\.com$/i,
  /(^|\.)raygun\.io$/i,
  /(^|\.)cloudflare\.com$/i,
  /(^|\.)godaddy\.com$/i,
  /(^|\.)squarespace\.com$/i,
  /(^|\.)wordpress\.com$/i,
  /(^|\.)shopify\.com$/i,
  /(^|\.)sentry\.wixpress\.com$/i,
];

/** Placeholder domains from templates and documentation. */
const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'domain.com',
  'yourdomain.com',
  'yoursite.com',
  'mysite.com',
  'website.com',
  'company.com',
  'email.com',
  'address.com',
  'xyz.com',
  'test.com',
  'sentry.local',
  'localhost',
]);

/**
 * The template forms of a placeholder domain: "you(r)/my" + an optional "web"
 * + a generic noun, e.g. yourwebsite.com, youwebsite.com, yourbusiness.com,
 * mydomain.net, yourcompanyname.com. Anchored on the whole first label so real
 * businesses that merely start with "your" — yourcatvet.com, yourgreenpal.com —
 * are not caught. Found in the data: info@youwebsite.com, support@yourdomain.tld.
 */
const PLACEHOLDER_DOMAIN_RE =
  /^(?:your|you|my)-?(?:web)?(?:site|domain|company|business|email|mail|url|server)?(?:-?name)?\.[a-z.]+$/;

/**
 * Local parts that are a template's filler, not a mailbox: example@mail.com,
 * firstname.lastname@tkelevator.com, mymail@mailservice.com, all found in the
 * data. `email@` is deliberately absent — real businesses use it
 * (email@rockyheights.com).
 */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  'example',
  'sample',
  'yourname',
  'your.name',
  'youremail',
  'your.email',
  'yourmail',
  'myemail',
  'mymail',
  'firstname',
  'firstname.lastname',
  'first.last',
  'firstlast',
  'john.doe',
  'johndoe',
  'jane.doe',
  'janedoe',
  'name.surname',
  'someone',
]);

/**
 * Mailboxes that never reach anyone who buys: a privacy or legal department's,
 * and the plumbing that mail and websites need (RFC 2142 and friends). Every
 * form here came from the data: dataprivacy@, privacyofficer@, legalnotices@,
 * rglegalinquiries@, wnig.legal@, dmca_agent@, compliancebr@.
 *
 * "legal" only as a whole mailbox: yuraqlegal@gmail.com is Yuraq Legal Services'
 * real address. And see {@link isNonContact} for firms where the word is the
 * trade. Departments that reach a person (careers@, billing@, press@) are kept,
 * and ranked last by the by-business export instead.
 */
const NON_CONTACT_LOCAL_RE = new RegExp(
  [
    'privacy',
    'ccpa',
    'gdpr',
    'dmca',
    'copyright',
    'unsubscribe',
    'no[-_.]?reply',
    'do[-_.]?not[-_.]?reply',
    'mailer-?daemon',
    'legal[-_.]?(?:notices?|inquir(?:y|ies))',
    '^legal$',
    '\\.legal$',
    '^compliance',
    '^(?:abuse|bounces?|bugreport|dpo|hostmaster|postmaster|webmaster)$',
  ].join('|'),
);

/**
 * Whether a mailbox is one of those, unless the word is what the firm does:
 * legal@jdwcounsel.com is a law firm's front door, and compliance@ at a
 * compliance consultancy is its sales line.
 */
function isNonContact(localPart: string, domain: string): boolean {
  const word = NON_CONTACT_LOCAL_RE.exec(localPart)?.[0];
  if (word === undefined) return false;
  const label = domainLabel(domain);
  if (word.includes('legal') && /law|legal|counsel|attorney|esq/.test(label)) return false;
  return !label.includes(squash(word));
}

/** File extensions that mean the "domain" is really a filename. */
const ASSET_EXTENSIONS =
  /\.(jpg|jpeg|png|gif|svg|webp|avif|bmp|ico|css|js|mjs|json|xml|pdf|woff2?|ttf|eot|mp4|webm|mp3|zip|gz)$/i;

/**
 * Government domains.
 *
 * `.gov` and `.mil` cover US federal, and most state and local bodies use
 * `state.xx.us`, `ci.xx.us`, `co.xx.us` or a `.gov` subdomain. `k12.xx.us` is
 * schools, which are government-run and equally not prospects.
 */
/**
 * Each alternative is anchored with `(^|\.)`, not a bare `\.`.
 *
 * A leading-dot-only pattern misses the label when it is *first* — city domains
 * are literally `ci.birmingham.al.us`, so `/\.ci\./` never fires on the one
 * shape it exists to catch.
 */
const GOVERNMENT_PATTERNS: readonly RegExp[] = [
  /\.gov$/i,
  /\.gov\.[a-z]{2}$/i,
  /\.mil$/i,
  /(^|\.)fed\.us$/i,
  // Tribal governments.
  /(^|\.)nsn\.us$/i,
  // The .us locality space: state.tx.us, ci.austin.tx.us, co.harris.tx.us. A bare
  // .us proves nothing — wsllc.us and perezlaw.us are ordinary businesses.
  /\.[a-z]{2}\.us$/i,
  // Municipalities on ordinary endings: cityofmobile.org, townofcary.com. Not
  // "office": cityofficefurniture.com is a furniture shop.
  /^(?:city|town|village|county|borough|township)of(?!fice)[a-z0-9-]+\./i,
  // Known from the data, and not recognisable by shape. Add others through
  // enrichment.websiteEmails.validation.blockedDomains.
  /(^|\.)(?:muni\.org|anchorageak\.org|ahfc\.us)$/i,
  /(^|\.)usps\.com$/i,
];

/** Offices that exist only in government, wherever the address is hosted. */
const GOVERNMENT_LOCAL_PARTS = new Set([
  'mayor',
  'elections',
  'cityclerk',
  'townclerk',
  'countyclerk',
  'cityhall',
  'townhall',
  'sheriff',
  'citymanager',
]);

/** Educational institutions. */
const EDUCATION_PATTERNS: readonly RegExp[] = [
  /\.edu$/i,
  /\.edu\.[a-z]{2}$/i,
  /(^|\.)ac\.[a-z]{2}$/i,
  /(^|\.)sch\.[a-z]{2}$/i,
];

/**
 * Reasonably strict address syntax.
 *
 * Deliberately not RFC 5322 — that grammar admits quoted strings and comments
 * that no real business address uses, and a permissive pattern is exactly how
 * `insurance_logos@2x.jpg` got in.
 */
const ADDRESS_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Local parts that are really an asset name.
 *
 * Deliberately narrow. An earlier version also matched `bg`, `img`, `hero` and
 * `banner`, which rejected `BG@rushtonstakely.com` — a law firm, where "BG" is
 * somebody's initials. Initials-based addresses are the norm in professional
 * services, which is a core target segment.
 *
 * The costs are asymmetric: a false positive silently loses a real lead, while
 * a false negative adds one obvious junk row. So this only matches words that
 * are never a person, and requires more than two characters so no set of
 * initials can collide.
 */
const FILENAME_LOCAL_RE = /^(logo|logos|favicon|sprite|placeholder|thumbnail|screenshot)[-_]?\d*$/i;

/** An asset name with a pixel-density suffix: `logo@2x`, `icon_3x`. */
const DENSITY_SUFFIX_RE = /^[a-z0-9_-]+[@_-][23]x$/i;

/** A long hex run — a Sentry public key or similar, never a mailbox. */
const HASH_LOCAL_RE = /^[0-9a-f]{16,}$/i;

/**
 * Strip artefacts that survive from HTML into a captured address.
 *
 * `u003Eprivacy@gatech.edu` is a real example from the legacy output: a
 * JSON-escaped `>` welded onto the front because the extractor regexed raw
 * innerHTML instead of decoded text.
 */
export function cleanAddress(raw: string): string {
  return (
    raw
      .trim()
      .replace(/^[<>("'\s]+|[<>)"'\s.,;:]+$/g, '')
      // Escaped entity prefixes: >, &gt;, %3E and friends.
      .replace(/^(?:u00[0-9a-f]{2}|&[a-z]+;|%[0-9a-f]{2})+/i, '')
      .replace(/^mailto:/i, '')
      .toLowerCase()
  );
}

/**
 * Classify one address.
 *
 * Pure and total: it never throws, and always returns a verdict with a reason.
 */
export function validateEmail(raw: string, options: ValidationOptions = {}): EmailVerdict {
  const address = cleanAddress(raw);
  const atIndex = address.lastIndexOf('@');
  const localPart = atIndex > 0 ? address.slice(0, atIndex) : address;
  const domain = atIndex > 0 ? address.slice(atIndex + 1) : '';

  const base = { address, localPart, domain };
  const junk = (junkReason: JunkReason): EmailVerdict => ({
    ...base,
    isJunk: true,
    junkReason,
    isRole: false,
    isFree: false,
  });

  // 1. Syntax. Catches most filename-shaped matches immediately.
  if (!ADDRESS_RE.test(address)) return junk('syntax');

  // 2. A domain ending in a file extension is a filename, not a host.
  if (ASSET_EXTENSIONS.test(domain)) return junk('asset_extension');

  // 2b. A domain whose ending is not a real one (".tld", ".local", ".invalid")
  // cannot receive mail. The public-suffix list knows every real ending,
  // including the newer ones such as .agency and .lawyer. After the asset check,
  // so `logo@2x.png` keeps the more telling reason.
  if (parse(domain).isIcann !== true) return junk('invalid_tld');

  // 3. The address was really a fragment of a URL.
  if (/^(https?|www)/i.test(localPart) || localPart.includes('/')) return junk('inside_url');

  // 4. Vendor telemetry.
  if (VENDOR_DOMAINS.some((pattern) => pattern.test(domain))) return junk('vendor_telemetry');

  // 5. Template placeholders.
  if (
    PLACEHOLDER_DOMAINS.has(domain) ||
    PLACEHOLDER_DOMAIN_RE.test(domain) ||
    PLACEHOLDER_LOCAL_PARTS.has(localPart)
  ) {
    return junk('placeholder');
  }

  // 6. A hex-run local part is a public key, not a mailbox.
  if (HASH_LOCAL_RE.test(localPart)) return junk('hash_local_part');

  // 7. An asset name as the local part.
  if (FILENAME_LOCAL_RE.test(localPart) || DENSITY_SUFFIX_RE.test(localPart)) {
    return junk('filename_local_part');
  }

  // 8. Government.
  if (
    options.excludeGovernment !== false &&
    (GOVERNMENT_PATTERNS.some((p) => p.test(domain)) || GOVERNMENT_LOCAL_PARTS.has(localPart))
  ) {
    return junk('government');
  }

  // 9. Education. The largest junk source in the legacy data by a wide margin.
  if (options.excludeEducation !== false && EDUCATION_PATTERNS.some((p) => p.test(domain))) {
    return junk('education');
  }

  // 10. Explicit blocklist.
  if (options.blockedDomains?.some((d) => domain === d || domain.endsWith(`.${d}`)) === true) {
    return junk('placeholder');
  }

  // 11. A department or machine nobody answers for business. Last, so an address
  // rejected for its domain keeps that more telling reason.
  if (isNonContact(localPart, domain)) return junk('non_contact');

  return {
    ...base,
    isJunk: false,
    junkReason: null,
    isRole: ROLE_LOCAL_PARTS.has(localPart),
    isFree: FREE_PROVIDERS.has(domain),
  };
}

/**
 * How likely an address belongs to the business whose site it was found on.
 *
 * Same registrable domain is near-certain. A free provider on a small business's
 * site is usually still theirs. A different corporate domain is usually a web
 * designer, a supplier, or a partner — kept, but ranked low.
 */
export function confidenceFor(verdict: EmailVerdict, siteDomain: string | null): number {
  if (siteDomain !== null && verdict.domain === siteDomain) return 1;
  if (siteDomain !== null && verdict.domain.endsWith(`.${siteDomain}`)) return 0.9;
  if (verdict.isFree) return 0.7;
  return 0.4;
}

/**
 * Generic mailboxes that are not a role at a business so much as plumbing:
 * these, like role addresses, are what a site's builder or platform leaves in
 * a footer or privacy page.
 */
const SYSTEM_LOCAL_RE =
  /(legal|privacy|compliance|support|bug|dmca|copyright|noreply|no-reply|donotreply|postmaster|webmaster|abuse|recruit|careers)/;

/** Lowercase letters and digits only, for comparing names and domains. */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The registrable domain without its suffix, squashed: "red-mountain.co.uk" → "redmountain". */
function domainLabel(domain: string): string {
  return squash(parse(domain).domainWithoutSuffix ?? domain.split('.')[0] ?? '');
}

/** Length of the longest run of characters the two strings share. */
function longestCommonRun(a: string, b: string): number {
  let best = 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (previous[j]! > best) best = previous[j]!;
      diagonal = above;
    }
  }
  return best;
}

/** "Mortgage Brokers of Alaska" → "mboa": how acronym domains are formed. */
function initials(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word[0])
    .join('');
}

/**
 * Whether an address found on a business's website belongs to someone else —
 * the site's builder, platform or a vendor — rather than to the business.
 *
 * Measured on the real data, the culprits are generic mailboxes on a domain
 * unrelated to the business: support@overfuel.com on a dealer's site,
 * contact@bizsite.link on a site built with it, bugreport@moatable.com on 25
 * unrelated sites. So an address belongs elsewhere when all of these hold:
 *
 *  - it is not on the business's own website domain, and not free mail;
 *  - it is a generic or system mailbox, not a person — jeffswickard@swickard.com
 *    on Swickard's own dealership sites is a real person and stays;
 *  - its domain has nothing meaningful in common with the business's website
 *    or name. "Meaningful" is a shared run of 5+ characters
 *    (rmgaragedoors / redmountaingaragedoors), one containing the other, the
 *    same first three letters (sosalaska / sosrestorationak), or the name's
 *    initials (akmboa / Mortgage Brokers of Alaska). Plain substring matching
 *    was too blunt: it dropped exactly those, which are the businesses' own
 *    second domains.
 *
 * Judged per business, never per address: support@overfuel.com is a fine
 * lead for Overfuel itself.
 */
export function belongsElsewhere(
  email: {
    readonly localPart: string;
    readonly domain: string;
    readonly isRole: boolean;
    readonly isFree: boolean;
  },
  site: string | null,
  businessName: string,
): boolean {
  if (email.isFree) return false;
  if (site !== null && email.domain === site) return false;
  if (!email.isRole && !SYSTEM_LOCAL_RE.test(email.localPart)) return false;

  const label = domainLabel(email.domain);
  if (label.length < 3) return false; // too short to judge; keep it
  const siteLabel = site === null ? '' : domainLabel(site);
  const name = squash(businessName);

  for (const other of [siteLabel, name]) {
    if (other === '') continue;
    if (other.includes(label) || label.includes(other)) return false;
    if (longestCommonRun(label, other) >= 5) return false;
    // The same opening: sosalaska / sosrestorationak.
    if (other.length >= 3 && label.slice(0, 3) === other.slice(0, 3)) return false;
  }
  // An acronym of the name's first words: akmboa / "Mortgage Brokers of Alaska,
  // LLC", ntreak / "Northern Trust Real Estate". Trailing words (LLC, Inc)
  // rarely make it into a domain, so every leading run of 3+ initials counts.
  const acronym = initials(businessName);
  for (let length = acronym.length; length >= 3; length -= 1) {
    if (label.includes(acronym.slice(0, length))) return false;
  }
  return true;
}
