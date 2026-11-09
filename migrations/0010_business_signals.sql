-- What a beauty campaign needs to know about a business beyond its contact
-- details: its Instagram profile, the online-booking platform it takes
-- appointments through, and whether it works by appointment only.
--
-- On the business: what its Maps listing shows (its "Book online" links, a
-- website that is really an Instagram or Planity page, its name). On the
-- domain: what the business's own website links to, found by the email crawl.
-- The exports take the business's value first and fall back to its site's.

ALTER TABLE businesses ADD COLUMN instagram_url TEXT;
ALTER TABLE businesses ADD COLUMN booking_provider TEXT;
ALTER TABLE businesses ADD COLUMN booking_url TEXT;
ALTER TABLE businesses ADD COLUMN by_appointment INTEGER NOT NULL DEFAULT 0
  CHECK (by_appointment IN (0, 1));

ALTER TABLE domains ADD COLUMN instagram_url TEXT;
ALTER TABLE domains ADD COLUMN booking_provider TEXT;
ALTER TABLE domains ADD COLUMN booking_url TEXT;
ALTER TABLE domains ADD COLUMN by_appointment INTEGER NOT NULL DEFAULT 0
  CHECK (by_appointment IN (0, 1));

-- A booking platform or a link-in-bio page is not a business's website: its
-- addresses are the platform's. Retire any queued for crawling, as 0008 did
-- for Google's own hosts. Domains already crawled keep their history.
UPDATE domains
   SET is_social = 1, status = 'skipped'
 WHERE status = 'pending'
   AND domain IN (
     'planity.com', 'treatwell.fr', 'treatwell.com', 'treatwell.co.uk', 'mytreatwell.fr',
     'fresha.com', 'booksy.com', 'iwana.fr', 'glaura.fr', 'kiute.com', 'salonkee.fr',
     'salonkee.com', 'clicrdv.com', 'calendly.com', 'simplybook.me', 'vagaro.com',
     'linktr.ee', 'beacons.ai', 'lnk.bio', 'taplink.cc'
   );
