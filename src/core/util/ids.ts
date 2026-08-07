/**
 * Identifier generation.
 *
 * Run ids are ULIDs rather than UUIDv4 because they sort lexicographically by
 * creation time. `ORDER BY id` on the runs table is then chronological with no
 * separate index, and a directory listing of `data/logs/` is in run order.
 */
import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so ids cannot be misread aloud or produce
// unfortunate words.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = TIME_CHARS - 1; i >= 0; i -= 1) {
    out = ENCODING[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_CHARS);
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    // Modulo 32 of a byte is very slightly biased toward low values. Irrelevant
    // for collision resistance at 80 bits and this volume.
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

/** A 26-character, time-sortable, URL-safe identifier. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/**
 * Identify one worker within one process.
 *
 * Used as `jobs.lease_owner`. It must be unique across every process that could
 * touch the database — two `gms run` invocations on one host is a supported
 * setup — so it carries the pid alongside the worker index, plus a short random
 * suffix to survive pid reuse after a crash.
 */
export function workerId(index: number, pid: number = process.pid): string {
  return `w${index}-${pid}-${randomBytes(3).toString('hex')}`;
}
