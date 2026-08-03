-- 0001_baseline
--
-- Establishes the instance identity table. Domain tables (cities, categories,
-- jobs, businesses, ...) arrive with the milestones that use them; adding them
-- here would be schema for code that does not exist yet.
--
-- `meta` is a typed key/value store for facts about this installation that must
-- survive restarts and belong with the data rather than with the config file:
-- the install id, when the database was created, and which application version
-- created it.

CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
