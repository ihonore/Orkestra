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
import { crawlDomain, startUrlFor } from '../../enrichment/website-emails/crawler.js';
import { openDatabaseFromConfig } from '../../db/client.js';
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
  let crawled = 0;
  let emailsLinked = 0;
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
        emails.finishDomain(domain.id, {
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

      const session = proxies.acquire('http');
      const result = await crawlDomain({
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
              sourceUrl: found.sourceUrl,
              sourceDomainId: domain.id,
              method: found.method,
              confidence: found.confidence,
              pageDepth: found.depth,
            });
            emailsLinked += 1;
          }
        }

        const recrawlDays = config.enrichment.websiteEmails.recrawlAfterDays;
        emails.finishDomain(domain.id, {
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
    }
  }

  try {
    const workerCount = Math.max(1, options.workers ?? config.runtime.httpWorkers);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    const stats = emails.stats();
    const junk = emails.junkBreakdown();

    if (options.json === true) {
      console.log(JSON.stringify({ runId, crawled, stats, junk }, null, 2));
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
  }
}
