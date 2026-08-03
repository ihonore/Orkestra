/**
 * Instance metadata: durable facts about this database that belong with the
 * data rather than the config file.
 */
import { randomUUID } from 'node:crypto';
import { BaseRepository, type Timestamp } from './types.js';

export const META_KEYS = {
  /** Stable identifier for this installation. Correlates logs and exports. */
  installId: 'install_id',
  createdAt: 'created_at',
  /** Application version that last opened this database. */
  appVersion: 'app_version',
} as const;

export interface MetaEntry {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: Timestamp;
}

interface MetaRow {
  key: string;
  value: string;
  updated_at: number;
}

export class MetaRepository extends BaseRepository {
  get(key: string): string | undefined {
    return this.driver.prepare<MetaRow>(`SELECT * FROM meta WHERE key = ?`).get([key])?.value;
  }

  set(key: string, value: string, now: Timestamp = Date.now()): void {
    this.driver
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run([key, value, now]);
  }

  all(): MetaEntry[] {
    return this.driver
      .prepare<MetaRow>(`SELECT * FROM meta ORDER BY key`)
      .all()
      .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  /**
   * Return the install id, creating it on first call.
   *
   * Written in a transaction so two processes racing on a fresh database cannot
   * produce two different ids.
   */
  ensureInstallId(now: Timestamp = Date.now()): string {
    return this.inTransaction((driver) => {
      const existing = driver
        .prepare<MetaRow>(`SELECT * FROM meta WHERE key = ?`)
        .get([META_KEYS.installId]);
      if (existing !== undefined) return existing.value;

      const installId = randomUUID();
      driver
        .prepare(`INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)`)
        .run([META_KEYS.installId, installId, now]);
      driver
        .prepare(
          `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO NOTHING`,
        )
        .run([META_KEYS.createdAt, String(now), now]);
      return installId;
    });
  }
}
