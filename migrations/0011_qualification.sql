-- Qualification: which leads a campaign wants, and in what order they are
-- ready to hand over.
--
-- categories.specialty: what a search term means for the campaign
--   ("tresses" -> Coiffure), from the Specialty column of services.csv.
-- businesses.specialty: the business's own, from its Google category, else
--   from the search that found it.
-- businesses.category_label: its Google category in the campaign's words
--   ("Nail salon" -> "Onglerie"); Maps is read in English.
-- businesses.exclusion_reason: why the campaign does not want it (a chain, a
--   hotel spa, out of area...), in words. NULL means wanted. Recomputed on
--   every qualification pass, so editing the rules or opening an area takes
--   effect without re-scraping.
-- businesses.lead_seq: when the lead became ready to send — wanted, and its
--   email search finished. Only ever grows, which is what lets an export send
--   each lead once, phone-only leads included.
--
-- All NULL for a campaign that does not qualify its leads.

ALTER TABLE categories ADD COLUMN specialty TEXT;

ALTER TABLE businesses ADD COLUMN specialty TEXT;
ALTER TABLE businesses ADD COLUMN category_label TEXT;
ALTER TABLE businesses ADD COLUMN exclusion_reason TEXT;
ALTER TABLE businesses ADD COLUMN lead_seq INTEGER;

CREATE UNIQUE INDEX businesses_lead_seq ON businesses (lead_seq) WHERE lead_seq IS NOT NULL;
