import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface ProviderTtsModelRow {
  provider_config_id: string;
  model:              string;
  created_at:         number;
}

export interface ProviderTtsModelInsert {
  providerConfigId: string;
  model:            string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class ProviderTtsModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  listByProvider(providerConfigId: string): ProviderTtsModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_tts_models WHERE provider_config_id = ? ORDER BY created_at ASC')
      .all(providerConfigId) as ProviderTtsModelRow[];
  }

  /** 所有启用了该 TTS 模型的 provider。 */
  listByModel(model: string): ProviderTtsModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_tts_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderTtsModelRow[];
  }

  get(providerConfigId: string, model: string): ProviderTtsModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_tts_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderTtsModelRow | undefined;
  }

  listAll(): ProviderTtsModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_tts_models ORDER BY provider_config_id, created_at ASC')
      .all() as ProviderTtsModelRow[];
  }

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_tts_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_tts_models WHERE model = ?')
      .get(model) !== undefined;
  }

  upsert(input: ProviderTtsModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_tts_models (provider_config_id, model, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO NOTHING`,
      )
      .run(input.providerConfigId, input.model, Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_tts_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
