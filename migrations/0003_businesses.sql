-- Google Maps results: businesses, where each was seen, and their websites.

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY,

  -- The Google customer id, in decimal. TEXT, not INTEGER, and this is not a
  -- style choice: CID is an unsigned 64-bit value (e.g. 10281119596374313554)
  -- that exceeds JavaScript's safe integer range and goes negative under signed
  -- parsing. Storing it as a number silently corrupts the only stable key this
  -- data has, and the damage is invisible until you try to join on it.
  cid TEXT,

  -- The hex feature id from the listing URL, '0x88f5...:0xc2f0...'. CID is
  -- derived from its second half, so this is the audit trail for that.
  fid TEXT,

  -- ChIJ... Present only when an XHR payload carried it. Google documents that
  -- place_id can change, which is why CID is the internal key and this is not.
  place_id TEXT,

  -- CID when known, else a hash of name + phone + rounded coordinates. Every
  -- business has one, so dedup works even for the ~30% of listings that arrive
  -- without a CID.
  dedup_hash TEXT NOT NULL,

  name TEXT NOT NULL,
  category_primary TEXT,
  categories_json TEXT,

  rating REAL,
  reviews_count INTEGER,
  price_level INTEGER,

  phone_raw TEXT,
  phone_e164 TEXT,

  address_raw TEXT,
  street TEXT,
  city TEXT,
  state_code TEXT,
  postal_code TEXT,
  country TEXT,

  lat REAL,
  lng REAL,
  plus_code TEXT,

  -- website_raw is what the page gave us, which for Google is a /url?q=...
  -- redirect. website_url is the unwrapped target. Keeping both means a parsing
  -- bug is diagnosable after the fact instead of silently losing the address.
  website_raw TEXT,
  website_url TEXT,
  domain_id INTEGER REFERENCES domains(id),

  gmaps_url TEXT,
  thumbnail_url TEXT,
  hours_json TEXT,
  permanently_closed INTEGER NOT NULL DEFAULT 0 CHECK (permanently_closed IN (0, 1)),

  -- Which channel each field came from, e.g. {"name":"xhr","phone":"dom"}.
  -- This is what makes selector rot diagnosable: when a field's fill rate drops,
  -- this says whether the XHR shape moved or the DOM did.
  extraction_source TEXT,
  raw_json TEXT,

  automation_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  first_run_id TEXT,
  last_run_id  TEXT
) STRICT;

-- Partial unique: many listings have no CID, and NULLs are distinct in SQLite,
-- so a plain UNIQUE would admit unlimited CID-less duplicates.
CREATE UNIQUE INDEX businesses_cid_idx   ON businesses (cid) WHERE cid IS NOT NULL;
CREATE UNIQUE INDEX businesses_dedup_idx ON businesses (dedup_hash);
CREATE INDEX businesses_domain_idx       ON businesses (domain_id);
CREATE INDEX businesses_geo_idx          ON businesses (state_code, city);
CREATE INDEX businesses_seen_idx         ON businesses (last_seen_at DESC);

-- Where and how each business was found.
--
-- This is the table the legacy system lacked, and its absence caused two
-- distinct problems: the same business scraped under several search terms
-- became several rows, and there was no way to tell that a "Birmingham" search
-- had returned a business in a neighbouring town. Provenance lives here so
-- `businesses` can hold exactly one row per real business.
CREATE TABLE business_sightings (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,

  -- What we searched for, as opposed to where the business actually is.
  seed_city_id     INTEGER REFERENCES cities(id),
  seed_category_id INTEGER REFERENCES categories(id),
  search_query TEXT NOT NULL,
  rank_in_results INTEGER,
  seen_at INTEGER NOT NULL,

  -- One sighting per business per job. Re-running a job after a crash must not
  -- add a second row, which is what makes resume idempotent.
  UNIQUE (business_id, job_id)
) STRICT;

CREATE INDEX sightings_business_idx ON business_sightings (business_id);
CREATE INDEX sightings_job_idx      ON business_sightings (job_id);
CREATE INDEX sightings_seed_idx     ON business_sightings (seed_city_id, seed_category_id);

-- One row per registrable domain, shared across every business that uses it.
--
-- A franchise's shared site is crawled once for all its locations rather than
-- once per location, which is the difference between 15,000 crawls and 4,000.
CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,        -- registrable, lowercased, no leading www
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'crawling', 'done', 'failed', 'skipped', 'parked')),

  http_status INTEGER,
  final_url TEXT,
  is_parked   INTEGER NOT NULL DEFAULT 0 CHECK (is_parked IN (0, 1)),
  -- facebook.com/x is a social profile, not a business website; crawling it for
  -- an email finds Facebook's, not the business's.
  is_social   INTEGER NOT NULL DEFAULT 0 CHECK (is_social IN (0, 1)),
  -- Set when a domain yields implausibly many addresses — a university or
  -- directory rather than one business.
  is_directory_like INTEGER NOT NULL DEFAULT 0 CHECK (is_directory_like IN (0, 1)),

  robots_json TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  bytes_fetched INTEGER NOT NULL DEFAULT 0,
  emails_found  INTEGER NOT NULL DEFAULT 0,
  used_js_fallback INTEGER NOT NULL DEFAULT 0 CHECK (used_js_fallback IN (0, 1)),

  last_crawled_at INTEGER,
  next_eligible_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX domains_status_idx ON domains (status, next_eligible_at);
