import type { SqliteDb } from '../database.js';
import type { LlmProvider } from '@ema-agent/contracts';

export interface ProviderHealthRow {
  llm_provider: LlmProvider;
  status: 'ok' | 'failed' | 'probing' | 'unknown';
  last_probed_at: number | null;
  latency_ms: number | null;
  last_error: string | null;
  consecutive_fails: number;
}

export class ProviderHealthRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(
    llmProvider: LlmProvider,
    status: ProviderHealthRow['status'],
    opts: { latencyMs?: number; lastError?: string; lastProbedAt?: number } = {},
  ): void {
    const now = opts.lastProbedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO provider_health (llm_provider, status, last_probed_at, latency_ms, last_error, consecutive_fails)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(llm_provider) DO UPDATE SET
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
        llmProvider as string,
        status,
        now,
        opts.latencyMs ?? null,
        opts.lastError ?? null,
        status === 'failed' ? 1 : 0,
      );
  }

  find(llmProvider: LlmProvider): ProviderHealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_health WHERE llm_provider = ?')
      .get(llmProvider as string) as ProviderHealthRow | undefined;
  }

  listAll(): ProviderHealthRow[] {
    return this.db.prepare('SELECT * FROM provider_health').all() as ProviderHealthRow[];
  }
}
