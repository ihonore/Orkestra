-- Websites that were Google's own servers.
--
-- The XHR channel took the first URL in a place payload as the website and
-- excluded only google.com and a few asset hosts. 849 businesses got a Street
-- View thumbnail (streetviewpixels-pa.googleapis.com) as their website, 51 an
-- ad server, and each such "domain" was queued and crawled as though it were
-- the business's site. None of them is anyone's website.
--
-- The extraction is fixed; this clears what it already wrote, so a re-scrape
-- can fill in the real website and nothing keeps pointing at Google.

CREATE TEMP TABLE google_hosts AS
  SELECT id FROM domains
   WHERE domain IN ('googleapis.com', 'googlesyndication.com', 'googleadservices.com',
                    'doubleclick.net', 'gstatic.com', 'ggpht.com', 'googleusercontent.com',
                    'ytimg.com', 'gvt1.com');

-- Addresses "found" on those hosts were never the businesses'.
DELETE FROM business_emails WHERE source_domain_id IN (SELECT id FROM google_hosts);

UPDATE businesses
   SET website_raw = NULL, website_url = NULL, domain_id = NULL
 WHERE domain_id IN (SELECT id FROM google_hosts);

-- Never crawl them again.
UPDATE domains SET status = 'skipped' WHERE id IN (SELECT id FROM google_hosts);

DROP TABLE google_hosts;
