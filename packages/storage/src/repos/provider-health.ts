import type { SqliteDb } from '../database.js';
import type { ProviderId } from '@ema-agent/contracts';

export interface ProviderHealthRow {
  provider_id: string;
  status: 'ok' | 'failed' | 'probing' | 'unknown';
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
  consecutive_fails: number;
}

export class ProviderHealthRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(
    providerId: ProviderId,
    status: ProviderHealthRow['status'],
    opts: { latencyMs?: number; lastError?: string; lastProbedAt?: number } = {},
  ): void {
    const now = opts.lastProbedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO provider_health (provider_id, status, last_probed_at, latency_ms, last_error, consecutive_fails)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           status            = excluded.status,
           last_probed_at    = excluded.last_probed_at,
           latency_ms        = excluded.latency_ms,
           last_error        = excluded.last_error,
           consecutive_fails = CASE
             WHEN excluded.status = 'failed' THEN consecutive_fails + 1
             ELSE 0
           END`,
      )
      .run(
        providerId,
        status,
        now,
        opts.latencyMs ?? null,
        opts.lastError ?? null,
        status === 'failed' ? 1 : 0,
      );
  }

  find(providerId: ProviderId): ProviderHealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_health WHERE provider_id = ?')
      .get(providerId) as ProviderHealthRow | undefined;
  }

  listAll(): ProviderHealthRow[] {
    return this.db.prepare('SELECT * FROM provider_health').all() as ProviderHealthRow[];
  }
}
