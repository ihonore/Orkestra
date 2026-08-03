import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, createSilentLogger } from '../src/core/logging/logger.js';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterEach(cleanupTempDirs);

/** Wait for pino's async transport to flush, then read the NDJSON log file. */
async function readLogLines(file: string, expected: number): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (fs.existsSync(file)) {
      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '');
      if (lines.length >= expected) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected} log line(s) in ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('logger', () => {
  it('writes NDJSON with the bound context on every line', async () => {
    const file = path.join(tempDir(), 'logs', 'run.ndjson');
    const logger = createLogger({ level: 'info', pretty: false, file, isTTY: false });

    logger.child({ runId: 'run-1', workerId: 'w3' }).info({ jobId: 42 }, 'leased job');
    logger.flush();

    const lines = await readLogLines(file, 1);
    const record = lines.find((line) => line['msg'] === 'leased job');

    expect(record).toBeDefined();
    expect(record?.['runId']).toBe('run-1');
    expect(record?.['workerId']).toBe('w3');
    expect(record?.['jobId']).toBe(42);
    expect(record?.['level']).toBe('info');
  });

  it('redacts secrets rather than writing them to disk', async () => {
    const file = path.join(tempDir(), 'logs', 'run.ndjson');
    const logger = createLogger({ level: 'info', pretty: false, file, isTTY: false });

    logger.info({ password: 'hunter2', proxy: { password: 'swordfish' } }, 'connecting');
    logger.flush();

    const lines = await readLogLines(file, 1);
    const raw = JSON.stringify(lines);

    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('swordfish');
    expect(raw).toContain('[redacted]');
  });

  it('honours the configured level', async () => {
    const file = path.join(tempDir(), 'logs', 'run.ndjson');
    const logger = createLogger({ level: 'warn', pretty: false, file, isTTY: false });

    logger.debug('should not appear');
    logger.warn('should appear');
    logger.flush();

    const lines = await readLogLines(file, 1);
    expect(lines.some((l) => l['msg'] === 'should appear')).toBe(true);
    expect(lines.some((l) => l['msg'] === 'should not appear')).toBe(false);
  });

  it('omits pid and hostname, which are noise for a single-host CLI', async () => {
    const file = path.join(tempDir(), 'logs', 'run.ndjson');
    const logger = createLogger({ level: 'info', pretty: false, file, isTTY: false });

    logger.info('hello');
    logger.flush();

    const [record] = await readLogLines(file, 1);
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
    expect(record).toHaveProperty('time');
  });

  it('creates the log directory if it does not exist', () => {
    const file = path.join(tempDir(), 'deep', 'nested', 'run.ndjson');
    createLogger({ level: 'info', pretty: false, file, isTTY: false });
    expect(fs.existsSync(path.dirname(file))).toBe(true);
  });

  it('provides a silent logger that swallows everything', () => {
    const logger = createSilentLogger();
    expect(() => logger.error('nothing should happen')).not.toThrow();
    expect(logger.level).toBe('silent');
  });
});
