-- Export watermarks.
--
-- Exporters are cursor-driven subscribers to the database, never the source of
-- truth. SQLite is written first, always, so a failed export can lose nothing —
-- it just resumes. The legacy system wrote straight to Sheets, so a failed
-- write silently dropped a listing forever.

CREATE TABLE export_cursors (
  exporter TEXT NOT NULL,          -- 'csv' | 'sheets'
  target   TEXT NOT NULL,          -- file path or spreadsheet id
  entity   TEXT NOT NULL,          -- 'leads-flat' | 'businesses' | 'emails'

  -- Highest source row id confirmed written. Advanced only *after* the write
  -- succeeds, so a crash mid-export re-exports a few rows rather than skipping
  -- them. Duplicates are recoverable; gaps are not.
  last_id  INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER,
  rows_total INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (exporter, target, entity)
) STRICT;
