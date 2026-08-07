/**
 * Failure artifacts.
 *
 * When a job fails, the difference between a five-minute fix and an afternoon is
 * whether you can see what the page actually looked like. Screenshot plus
 * trimmed HTML, written under `data/artifacts/{runId}/{jobId}/`.
 *
 * Paths are kept short and sanitized on purpose: Windows tooling still breaks at
 * 260 characters, and these names derive from scraped business names, which are
 * long and routinely contain emoji, CJK and slashes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Logger } from '../logging/logger.js';
import { safeSegment } from '../util/paths.js';

export interface ArtifactWriterOptions {
  readonly rootDir: string;
  readonly runId: string;
  readonly logger?: Logger;
  /** Cap on stored HTML. A Maps page is megabytes; the top of it is enough. */
  readonly maxHtmlBytes?: number;
}

export interface ArtifactRecord {
  readonly kind: 'screenshot' | 'html' | 'json';
  readonly path: string;
  readonly bytes: number;
}

export class ArtifactWriter {
  readonly #dir: string;
  readonly #maxHtmlBytes: number;

  constructor(private readonly options: ArtifactWriterOptions) {
    this.#dir = path.join(options.rootDir, safeSegment(options.runId, 32));
    this.#maxHtmlBytes = options.maxHtmlBytes ?? 512 * 1024;
  }

  /** Directory for one job's artifacts, created on demand. */
  dirFor(jobId: number | string): string {
    const dir = path.join(this.#dir, safeSegment(String(jobId), 24));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async screenshot(
    page: Page,
    jobId: number | string,
    name = 'failure',
  ): Promise<ArtifactRecord | null> {
    const file = path.join(this.dirFor(jobId), `${safeSegment(name, 32)}.png`);
    try {
      // fullPage is deliberately off: a Maps results feed can be tens of
      // thousands of pixels tall, and the viewport is what the user saw.
      await page.screenshot({ path: file, fullPage: false });
      return { kind: 'screenshot', path: file, bytes: fs.statSync(file).size };
    } catch (error) {
      this.options.logger?.debug({ err: String(error) }, 'screenshot failed');
      return null;
    }
  }

  async html(page: Page, jobId: number | string, name = 'page'): Promise<ArtifactRecord | null> {
    const file = path.join(this.dirFor(jobId), `${safeSegment(name, 32)}.html`);
    try {
      const content = await page.content();
      const trimmed = content.slice(0, this.#maxHtmlBytes);
      fs.writeFileSync(file, trimmed, 'utf8');
      return { kind: 'html', path: file, bytes: Buffer.byteLength(trimmed) };
    } catch (error) {
      this.options.logger?.debug({ err: String(error) }, 'html capture failed');
      return null;
    }
  }

  /** Store structured context alongside the visual artifacts. */
  json(jobId: number | string, name: string, data: unknown): ArtifactRecord | null {
    const file = path.join(this.dirFor(jobId), `${safeSegment(name, 32)}.json`);
    try {
      const text = JSON.stringify(data, null, 2);
      fs.writeFileSync(file, text, 'utf8');
      return { kind: 'json', path: file, bytes: Buffer.byteLength(text) };
    } catch (error) {
      this.options.logger?.debug({ err: String(error) }, 'json artifact failed');
      return null;
    }
  }

  /** Capture everything useful about a failed job in one call. */
  async captureFailure(
    page: Page,
    jobId: number | string,
    context: Record<string, unknown> = {},
  ): Promise<ArtifactRecord[]> {
    const records = await Promise.all([this.screenshot(page, jobId), this.html(page, jobId)]);
    const meta = this.json(jobId, 'context', { url: page.url(), ...context });
    return [...records, meta].filter((r): r is ArtifactRecord => r !== null);
  }
}

/**
 * Delete artifact directories older than `retainDays`.
 *
 * A long run produces a lot of these, and disk exhaustion on a VPS takes the
 * whole run down.
 */
export function pruneArtifacts(
  rootDir: string,
  retainDays: number,
  now: number = Date.now(),
): { removed: number; freedBytes: number } {
  if (!fs.existsSync(rootDir)) return { removed: 0, freedBytes: 0 };

  const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let freedBytes = 0;

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    const stat = fs.statSync(dir);
    if (stat.mtimeMs >= cutoff) continue;

    freedBytes += directorySize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }

  return { removed, freedBytes };
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}
