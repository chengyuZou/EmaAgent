import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface ProviderRerankModelRow {
  provider_config_id: string;
  model:              string;
  max_chunks:         number | null;
  created_at:         number;
}

export interface ProviderRerankModelInsert {
  providerConfigId: string;
  model:            string;
  maxChunks?:       number;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class ProviderRerankModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  listByProvider(providerConfigId: string): ProviderRerankModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_rerank_models WHERE provider_config_id = ? ORDER BY created_at ASC')
      .all(providerConfigId) as ProviderRerankModelRow[];
  }

  /** 所有启用了该 rerank 模型的 provider。 */
  listByModel(model: string): ProviderRerankModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_rerank_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderRerankModelRow[];
  }

  get(providerConfigId: string, model: string): ProviderRerankModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_rerank_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderRerankModelRow | undefined;
  }

  listAll(): ProviderRerankModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_rerank_models ORDER BY provider_config_id, created_at ASC')
      .all() as ProviderRerankModelRow[];
  }

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_rerank_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_rerank_models WHERE model = ?')
      .get(model) !== undefined;
  }

  upsert(input: ProviderRerankModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_rerank_models
           (provider_config_id, model, max_chunks, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO UPDATE SET
           max_chunks = excluded.max_chunks`,
      )
      .run(input.providerConfigId, input.model, input.maxChunks ?? null, Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_rerank_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
