import type { SqliteDb } from '../../database/database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export interface ProviderVisionModelRow {
  provider_config_id: string;
  model:              string;
  created_at:         number;
}

export interface ProviderVisionModelInsert {
  providerConfigId: string;
  model:            string;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider 的已启用 vision 模型池。一行 ⟺ 用户开启了该模型。
 * Vision 模型无额外元数据列,capability 标志(inputModalities 等)
 * 运行时从 models.dev catalog 获取。
 */
export class ProviderVisionModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 按 provider 查询 ──────────────────────────────────────────────────────

  listByProvider(providerConfigId: string): ProviderVisionModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_vision_models
                WHERE provider_config_id = ?
                ORDER BY created_at ASC, model ASC`)
      .all(providerConfigId) as ProviderVisionModelRow[];
  }

  // ── 按 model 查询 ─────────────────────────────────────────────────────────

  /** 所有启用了该 vision 模型的 provider。 */
  listByModel(model: string): ProviderVisionModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_vision_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderVisionModelRow[];
  }

  // ── 精确查询 ─────────────────────────────────────────────────────────────

  get(providerConfigId: string, model: string): ProviderVisionModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderVisionModelRow | undefined;
  }

  // ── 整个池 ───────────────────────────────────────────────────────────────

  listAll(): ProviderVisionModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_vision_models
                ORDER BY provider_config_id ASC, created_at ASC, model ASC`)
      .all() as ProviderVisionModelRow[];
  }

  // ── 存在性检查 ───────────────────────────────────────────────────────────

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_vision_models WHERE model = ?')
      .get(model) !== undefined;
  }

  // ── 写操作 ────────────────────────────────────────────────────────────────

  upsert(input: ProviderVisionModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_vision_models (provider_config_id, model, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO NOTHING`,
      )
      .run(input.providerConfigId, input.model, Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_vision_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
