-- Email links that belong to someone other than the business.
--
-- A business's website often carries its builder's or platform's address —
-- support@overfuel.com in a dealer's footer, contact@bizsite.link on a site
-- built with it — and every address on the site was linked to the business.
-- Deciding which ones are really the business's needs its name and website,
-- so it is judged in code when the link is made (and for existing links each
-- time the email crawl starts), and recorded here for the exports to skip.
--
-- Per link, not per address: support@overfuel.com is Overfuel's own address.

ALTER TABLE business_emails
  ADD COLUMN off_site INTEGER NOT NULL DEFAULT 0 CHECK (off_site IN (0, 1));
