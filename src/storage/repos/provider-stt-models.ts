import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface ProviderSttModelRow {
  provider_config_id: string;
  model:              string;
  created_at:         number;
}

export interface ProviderSttModelInsert {
  providerConfigId: string;
  model:            string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class ProviderSttModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  listByProvider(providerConfigId: string): ProviderSttModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_stt_models
                WHERE provider_config_id = ?
                ORDER BY created_at ASC, model ASC`)
      .all(providerConfigId) as ProviderSttModelRow[];
  }

  /** 所有启用了该 STT 模型的 provider。 */
  listByModel(model: string): ProviderSttModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_stt_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderSttModelRow[];
  }

  get(providerConfigId: string, model: string): ProviderSttModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_stt_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderSttModelRow | undefined;
  }

  listAll(): ProviderSttModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_stt_models
                ORDER BY provider_config_id ASC, created_at ASC, model ASC`)
      .all() as ProviderSttModelRow[];
  }

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_stt_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_stt_models WHERE model = ?')
      .get(model) !== undefined;
  }

  upsert(input: ProviderSttModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_stt_models (provider_config_id, model, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO NOTHING`,
      )
      .run(input.providerConfigId, input.model, Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_stt_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
