-- Email enrichment: one row per address, linked to the businesses that use it.

CREATE TABLE emails (
  id INTEGER PRIMARY KEY,

  -- Lowercased and punycode-normalized. UNIQUE, so an address shared by several
  -- businesses (a franchise's head office) is stored once.
  --
  -- Never comma-joined into a cell. The legacy sheet packed every address for a
  -- business into one field, which made per-address suppression, validation and
  -- deduplication impossible.
  address TEXT NOT NULL UNIQUE,
  local_part   TEXT NOT NULL,
  email_domain TEXT NOT NULL,

  is_role INTEGER NOT NULL DEFAULT 0 CHECK (is_role IN (0, 1)),   -- info@, sales@
  is_free INTEGER NOT NULL DEFAULT 0 CHECK (is_free IN (0, 1)),   -- gmail, yahoo

  -- Junk is stored, not discarded, with the rule that rejected it. Deleting it
  -- outright makes a bad rule invisible: you cannot audit what you cannot see,
  -- and tuning the rules needs the rejects.
  is_junk INTEGER NOT NULL DEFAULT 0 CHECK (is_junk IN (0, 1)),
  junk_reason TEXT,

  mx_valid INTEGER,
  mx_checked_at INTEGER,
  first_seen_at INTEGER NOT NULL
) STRICT;

CREATE INDEX emails_domain_idx ON emails (email_domain);
CREATE INDEX emails_usable_idx ON emails (is_junk, is_role);

CREATE TABLE business_emails (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email_id    INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,

  source_url TEXT NOT NULL,
  source_domain_id INTEGER REFERENCES domains(id),
  -- How it was found: mailto | jsonld | cfemail | obfuscated | text
  method TEXT NOT NULL,

  -- 1.0 same registrable domain as the business website, 0.7 a free provider,
  -- 0.4 some other corporate domain. An address on a different domain than the
  -- site it was found on is usually a supplier, a web designer, or a partner.
  confidence REAL NOT NULL,
  page_depth INTEGER,
  first_seen_at INTEGER NOT NULL,

  PRIMARY KEY (business_id, email_id)
) STRICT;

CREATE INDEX business_emails_email_idx ON business_emails (email_id);

CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  score REAL,
  status_code INTEGER,
  content_hash TEXT,
  bytes INTEGER,
  emails_found INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER,
  error TEXT,
  UNIQUE (domain_id, url)
) STRICT;

-- Compliance. CAN-SPAM requires a working opt-out honoured promptly, so the
-- suppression list exists from the first run rather than being retrofitted
-- after the first complaint.
CREATE TABLE suppressions (
  id INTEGER PRIMARY KEY,
  kind  TEXT NOT NULL CHECK (kind IN ('email', 'domain', 'phone', 'cid')),
  value TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
) STRICT;
