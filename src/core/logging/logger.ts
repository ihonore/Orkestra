/**
 * Structured logging.
 *
 * NDJSON to a per-run file, human-readable on a TTY. Every log line carries the
 * binding context (run, job, worker, proxy) so a 5-day run can be filtered after
 * the fact with `jq` rather than grep-and-hope.
 *
 * Built on `pino.multistream` rather than `transport.targets`: worker-thread
 * transports reject custom level formatters, and writing `"level":"warn"`
 * instead of `"level":40` is worth more than the marginal throughput. It also
 * keeps logging in-process, so a crash cannot lose buffered lines to a transport
 * worker that never got scheduled.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  destination,
  levels,
  multistream,
  pino,
  stdTimeFunctions,
  type DestinationStream,
  type Logger as PinoLogger,
} from 'pino';
import prettyStream from 'pino-pretty';
import { SECRET_LOG_PATHS } from '../../config/redact.js';
import type { LogLevel } from '../../config/schema.js';

export type Logger = PinoLogger;

/** Fields attached to every line a logger emits. */
export interface LogBindings {
  readonly runId?: string;
  readonly jobId?: number;
  readonly workerId?: string;
  readonly proxyId?: string;
  readonly automationId?: string;
  readonly [key: string]: unknown;
}

export interface CreateLoggerOptions {
  readonly level: LogLevel;
  /** `auto` means pretty on a TTY, NDJSON otherwise. */
  readonly pretty: boolean | 'auto';
  /** Absolute path for the NDJSON log file. Omit to log to the console only. */
  readonly file?: string;
  /** Extra redaction paths merged with the built-in secret paths. */
  readonly redact?: readonly string[];
  /** Overrides TTY detection. Tests set this explicitly. */
  readonly isTTY?: boolean;
}

function shouldPretty(pretty: boolean | 'auto', isTTY: boolean): boolean {
  return pretty === 'auto' ? isTTY : pretty;
}

/**
 * Build the application logger.
 *
 * When a file is configured, output is multiplexed: the console gets whatever
 * format suits it while the file always receives NDJSON. Pretty output is for
 * humans watching a run; the file is what gets analyzed afterwards.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const pretty = shouldPretty(options.pretty, isTTY);

  const streams: { level: LogLevel; stream: DestinationStream }[] = [
    {
      level: options.level,
      stream: pretty
        ? prettyStream({
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          })
        : process.stdout,
    },
  ];

  if (options.file !== undefined) {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
    streams.push({
      level: options.level,
      // sync: durability over throughput. A run that dies mid-job must leave
      // the log line that explains why.
      stream: destination({ dest: options.file, append: true, sync: true }),
    });
  }

  return pino(
    {
      level: options.level,
      // `pid`/`hostname` on every line is noise for a single-host CLI; the run
      // record carries them once instead. `null` omits them entirely.
      base: null,
      timestamp: stdTimeFunctions.isoTime,
      redact: {
        paths: [...SECRET_LOG_PATHS, ...(options.redact ?? [])],
        censor: '[redacted]',
      },
      formatters: {
        // Strings, not pino's numeric levels — these files are read by humans
        // and by `jq`, neither of which should have to map 30 to "info".
        level: (label) => ({ level: label }),
      },
    },
    multistream(streams, { levels: levels.values }),
  );
}

/** A logger that discards everything. For tests and `--quiet`. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
