/**
 * The searches a re-scrape queued, stored with the database.
 *
 * Shared by the re-scrape (which writes it and reports progress) and the queue
 * order (which runs those searches first), so neither has to import the other.
 */
import type { SqliteDriver } from '../db/driver/types.js';
import { MetaRepository } from '../db/repositories/meta.js';

const HOLD_KEY = 'rescrape_hold';

export interface Hold {
  readonly since: number;
  readonly ids: readonly number[];
}

export function readHold(driver: SqliteDriver): Hold | null {
  const raw = new MetaRepository(driver).get(HOLD_KEY);
  if (raw === undefined) return null;
  try {
    const hold = JSON.parse(raw) as Hold;
    return Array.isArray(hold.ids) ? hold : null;
  } catch {
    return null;
  }
}

export function writeHold(driver: SqliteDriver, hold: Hold): void {
  new MetaRepository(driver).set(HOLD_KEY, JSON.stringify(hold));
}
