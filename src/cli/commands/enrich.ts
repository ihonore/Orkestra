/**
 * `gms enrich emails` — crawl business websites for contact addresses.
 *
 * A separate command from `run` because it is a separate automation with its own
 * queue, its own concurrency, and its own failure modes. Decoupling them means a
 * slow website never stalls a browser worker, and enrichment can be re-run with
 * better rules without re-scraping Google Maps.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { ShutdownController } from '../../core/engine/shutdown.js';
import { createLogger } from '../../core/logging/logger.js';
import { createProxyProvider } from '../../core/proxy/factory.js';
import { ulid } from '../../core/util/ids.js';
import {
  crawlDomain,
  type CrawlResult,
  startUrlFor,
} from '../../enrichment/website-emails/crawler.js';
import { belongsElsewhere, validateEmail } from '../../enrichment/website-emails/validate/rules.js';
import { openDatabaseFromConfig } from '../../db/client.js';
import type { SqliteDriver } from '../../db/driver/types.js';
import { EmailsRepository } from '../../db/repositories/emails.js';
import { formatBytes, formatDuration, heading, keyValue, style, symbol } from '../output.js';
import path from 'node:path';

export interface EnrichCommandOptions {
  readonly config: ResolvedConfig;
  readonly workers?: number;
  readonly maxDomains?: number;
  readonly json?: boolean;
}

export async function runEnrichEmails(options: EnrichCommandOptions): Promise<void> {
  const { config } = options;
  const runId = ulid();

  const logger = createLogger({
    level: config.logging.level,
    pretty: config.logging.pretty,
    ...(config.logging.file && { file: path.join(config.paths.logsDir, `${runId}.ndjson`) }),
    redact: config.logging.redact,
  }).child({ runId, automationId: 'website-emails' });

  const driver = openDatabaseFromConfig(config);
  const emails = new EmailsRepository(driver);
  const proxies = createProxyProvider(config);

  const shutdown = new ShutdownController({
    graceSeconds: config.runtime.shutdownGraceSeconds,
    logger,
  });
  shutdown.install();
  // No database close here: shutdown tasks run while crawl workers are still
  // committing their results, and closing underneath them would discard the
  // work a graceful stop is meant to save. The `finally` block closes it.

  const startedAt = Date.now();
  const maxDomains = options.maxDomains ?? Number.POSITIVE_INFINITY;

  // Domains left claimed by a process that died mid-crawl.
  //
  // maxTimePerDomainMs is not an upper bound on how long a claim is held: it is
  // checked between pages, so a site asking for `Crawl-delay: 30` can hold one
  // well past it — eight pages of that is four minutes of waiting alone. The
  // lease is deliberately far larger than the budget, because reclaiming a
  // domain a live worker is still crawling costs a duplicate crawl, while
  // waiting too long only delays a retry.
  const domainLeaseMs = Math.max(
    1_800_000,
    config.enrichment.websiteEmails.maxTimePerDomainMs * 10,
  );
  const rejudged = rejudgeStoredEmails(driver, config);
  if (rejudged.junked > 0) {
    logger.info({ count: rejudged.junked }, 'stored addresses now rejected by newer rules');
  }
  if (rejudged.ownership > 0) {
    logger.info({ count: rejudged.ownership }, "email links re-judged as someone else's");
  }

  const reclaimed = emails.reclaimStalledDomains(domainLeaseMs);
  if (reclaimed > 0) {
    logger.info({ reclaimed }, 'returned stalled domains to the queue');
  }
  let crawled = 0;
  let emailsLinked = 0;
  let emailsRejected = 0;
  let bytesTotal = 0;

  async function worker(index: number): Promise<void> {
    const log = logger.child({ workerId: `http-${index}` });

    while (!shutdown.signal.aborted && crawled < maxDomains) {
      const domain = emails.claimDomain();
      if (domain === null) return;
      crawled += 1;

      // A suppressed domain is claimed and immediately retired, so it leaves the
      // queue rather than being re-claimed forever.
      if (emails.isSuppressed('domain', domain.domain)) {
        emails.finishDomain(domain.id, domain.crawl_epoch, {
          status: 'skipped',
          httpStatus: null,
          finalUrl: null,
          isParked: false,
          isDirectoryLike: false,
          pagesFetched: 0,
          bytesFetched: 0,
          emailsFound: 0,
          error: 'suppressed',
          nextEligibleAt: null,
        });
        continue;
      }

      // From here the domain is claimed, so every exit path has to either
      // finish it or give it back. A worker that just stops leaves the row
      // 'crawling', and the claim query only ever looks at 'pending'.
      let handedBack = false;
      try {
        const session = proxies.acquire('http');
        const result: CrawlResult = await crawlDomain({
          domain: domain.domain,
          startUrl: startUrlFor(domain.domain, domain.known_url),
          maxDepth: config.enrichment.websiteEmails.maxDepth,
          maxPages: config.enrichment.websiteEmails.maxPages,
          maxTimeMs: config.enrichment.websiteEmails.maxTimePerDomainMs,
          maxBytes: config.enrichment.websiteEmails.maxBytesPerDomain,
          maxEmailsPerPage: config.enrichment.websiteEmails.maxEmailsPerPage,
          maxEmailsPerDomain: config.enrichment.websiteEmails.maxEmailsPerDomain,
          respectRobots: config.http.respectRobots,
          perRequestDelayMs: config.http.perHostDelayMs,
          validation: {
            excludeGovernment: config.enrichment.websiteEmails.validation.excludeGovernment,
            excludeEducation: config.enrichment.websiteEmails.validation.excludeEducation,
            blockedDomains: config.enrichment.websiteEmails.validation.blockedDomains,
          },
          ...(session !== null && session.settings.server !== '' && { proxy: session.settings }),
          signal: shutdown.signal,
          logger: log,
        });

        if (session !== null) {
          proxies.release(session, result.status === 'failed' ? 'error' : 'ok');
        }
        bytesTotal += result.bytesFetched;

        const interrupted = result.stoppedBecause === 'aborted';

        // Store everything for this domain in one transaction, so a crash cannot
        // leave a domain marked done with only half its addresses recorded.
        driver.transaction(() => {
          const businesses = emails.businessesForDomain(domain.id);

          for (const found of result.emails) {
            if (emails.isSuppressed('email', found.verdict.address)) continue;

            const emailId = emails.upsertEmail({
              address: found.verdict.address,
              localPart: found.verdict.localPart,
              domain: found.verdict.domain,
              isRole: found.verdict.isRole,
              isFree: found.verdict.isFree,
              isJunk: false,
              junkReason: null,
            });

            for (const business of businesses) {
              emails.link({
                businessId: business.id,
                emailId,
                offSite: belongsElsewhere(found.verdict, domain.domain, business.name),
                sourceUrl: found.sourceUrl,
                sourceDomainId: domain.id,
                method: found.method,
                confidence: found.confidence,
                pageDepth: found.depth,
              });
              emailsLinked += 1;
            }
          }

          // Rejects are stored but never linked to a business, so they cannot
          // reach an export even by accident. They exist purely so the "Rejected"
          // breakdown can show which rule is throwing what away.
          for (const found of result.rejected) {
            emails.upsertEmail({
              address: found.verdict.address,
              localPart: found.verdict.localPart,
              domain: found.verdict.domain,
              isRole: found.verdict.isRole,
              isFree: found.verdict.isFree,
              isJunk: true,
              junkReason: found.verdict.junkReason,
            });
            emailsRejected += 1;
          }

          // An interrupted crawl is not a finished one. crawlDomain never
          // throws — on Ctrl-C it breaks its page loop and returns a normal
          // 'done' result — so without this check the domain would be recorded
          // as successfully crawled with whatever it happened to have, and put
          // on the 90-day recrawl cooldown. A site interrupted after one page
          // would look permanently email-less. The addresses already found are
          // still committed; only the completion is withheld.
          if (interrupted) return;

          const recrawlDays = config.enrichment.websiteEmails.recrawlAfterDays;
          emails.finishDomain(domain.id, domain.crawl_epoch, {
            status: result.status,
            httpStatus: result.httpStatus,
            finalUrl: result.finalUrl,
            isParked: result.isParked,
            isDirectoryLike: result.isDirectoryLike,
            pagesFetched: result.pagesFetched,
            bytesFetched: result.bytesFetched,
            emailsFound: result.emails.length,
            error: result.error,
            nextEligibleAt: Date.now() + recrawlDays * 24 * 60 * 60 * 1000,
          });
        }, 'immediate');

        log.info(
          {
            domain: domain.domain,
            status: result.status,
            emails: result.emails.length,
            pages: result.pagesFetched,
            stopped: result.stoppedBecause,
          },
          'domain crawled',
        );
        handedBack = !interrupted;
      } finally {
        // Reached whether the crawl finished, threw, or stopped early. A domain
        // that reached finishDomain is already out of 'crawling'; this covers
        // the two that do not — a throw, and a Ctrl-C partway through.
        if (!handedBack) {
          emails.releaseDomain(domain.id, domain.crawl_epoch);
          log.debug({ domain: domain.domain }, 'returned unfinished domain to the queue');
        }
      }
    }
  }

  try {
    const workerCount = Math.max(1, options.workers ?? config.runtime.httpWorkers);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    const stats = emails.stats();
    const junk = emails.junkBreakdown();

    if (options.json === true) {
      console.log(
        JSON.stringify({ runId, crawled, emailsLinked, emailsRejected, stats, junk }, null, 2),
      );
      return;
    }

    console.log(heading('Enrichment summary'));
    console.log(
      keyValue([
        ['run', runId],
        ['duration', formatDuration(Date.now() - startedAt)],
        ['domains crawled', String(crawled)],
        ['bytes fetched', formatBytes(bytesTotal)],
        ['links created', String(emailsLinked)],
        ['addresses rejected', String(emailsRejected)],
      ]),
    );

    console.log(heading('Emails'));
    console.log(
      keyValue([
        ['usable', String(stats['emails_usable'] ?? 0)],
        ['of which personal', String(stats['emails_personal'] ?? 0)],
        ['businesses reached', String(stats['businesses_with_email'] ?? 0)],
      ]),
    );

    console.log(heading('Domains'));
    console.log(
      keyValue(
        (['pending', 'done', 'failed', 'parked', 'skipped'] as const).map(
          (k) => [k, String(stats[`domains_${k}`] ?? 0)] as const,
        ),
      ),
    );

    if (junk.length > 0) {
      // Junk is reported, not hidden: a rule that is too aggressive is only
      // visible if you can see what it removed.
      console.log(heading('Rejected'));
      console.log(keyValue(junk.map((j) => [j.reason, String(j.n)] as const)));
    }

    console.log(
      `\n${symbol.ok} ${stats['emails_usable'] ?? 0} usable address(es) across ` +
        `${stats['businesses_with_email'] ?? 0} business(es)`,
    );
    if ((stats['domains_pending'] ?? 0) > 0) {
      console.log(style.grey(`${stats['domains_pending']} domain(s) still queued.`));
    }
  } finally {
    shutdown.uninstall();
    if (driver.open) driver.close();
    shutdown.exitWhenIdle();
  }
}

/**
 * Re-judge what is already stored against the current rules.
 *
 * Rules improve — placeholder checks, invented domain endings and the
 * builder's-address rule all arrived after thousands of addresses had been
 * kept — and a verdict made once at crawl time would otherwise stand forever,
 * so info@youwebsite.com and support@overfuel.com would keep reaching the
 * sheet. Run when the email crawl starts and by `gms db migrate`, so an update
 * applies its new rules before anything is exported.
 *
 * Junk is only ever added here; ownership is recomputed both ways, because a
 * re-scrape can correct a business's name or website.
 */
export function rejudgeStoredEmails(
  driver: SqliteDriver,
  config: ResolvedConfig,
): { junked: number; ownership: number } {
  const emails = new EmailsRepository(driver);
  const validation = {
    excludeGovernment: config.enrichment.websiteEmails.validation.excludeGovernment,
    excludeEducation: config.enrichment.websiteEmails.validation.excludeEducation,
    blockedDomains: config.enrichment.websiteEmails.validation.blockedDomains,
  };
  const rejects = emails
    .storedVerdicts()
    .filter((row) => row.is_junk === 0)
    .map((row) => ({ id: row.id, verdict: validateEmail(row.address, validation) }))
    .filter((row) => row.verdict.isJunk)
    .map((row) => ({ id: row.id, reason: row.verdict.junkReason ?? 'placeholder' }));
  const junked = emails.markJunk(rejects);

  const ownership = emails.setOffSite(
    emails.linksForReview().map((link) => ({
      rowid: link.rowid,
      offSite: belongsElsewhere(
        {
          localPart: link.local_part,
          domain: link.email_domain,
          isRole: link.is_role === 1,
          isFree: link.is_free === 1,
        },
        link.site,
        link.name,
      ),
    })),
  );
  return { junked, ownership };
}
