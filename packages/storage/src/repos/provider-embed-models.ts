import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type DimSource = 'live' | 'table' | 'manual';

export interface ProviderEmbedModelRow {
  provider_config_id: string;
  model:              string;
  dim:                number;
  dim_source:         DimSource;
  created_at:         number;
}

export interface ProviderEmbedModelInsert {
  providerConfigId: string;
  model:            string;
  dim:              number;
  dimSource?:       DimSource;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider 的已启用 embed 模型池。一行 ⟺ 用户开启了该模型。
 * `dim` 在启用时反范式存入(静态表 > 手动),memory 管线无需二次查询即可确定向量存储大小。
 */
export class ProviderEmbedModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 按 provider 查询 ──────────────────────────────────────────────────────

  listByProvider(providerConfigId: string): ProviderEmbedModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_embed_models
                WHERE provider_config_id = ?
                ORDER BY created_at ASC, model ASC`)
      .all(providerConfigId) as ProviderEmbedModelRow[];
  }

  // ── 按 model 查询 ─────────────────────────────────────────────────────────

  /** 所有启用了该 embed 模型的 provider。 */
  listByModel(model: string): ProviderEmbedModelRow[] {
    return this.db
      .prepare('SELECT * FROM provider_embed_models WHERE model = ? ORDER BY provider_config_id')
      .all(model) as ProviderEmbedModelRow[];
  }

  // ── 精确查询 ─────────────────────────────────────────────────────────────

  get(providerConfigId: string, model: string): ProviderEmbedModelRow | undefined {
    return this.db
      .prepare('SELECT * FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) as ProviderEmbedModelRow | undefined;
  }

  // ── 整个池 ───────────────────────────────────────────────────────────────

  listAll(): ProviderEmbedModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_embed_models
                ORDER BY provider_config_id ASC, created_at ASC, model ASC`)
      .all() as ProviderEmbedModelRow[];
  }

  // ── 存在性检查 ───────────────────────────────────────────────────────────

  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_embed_models WHERE model = ?')
      .get(model) !== undefined;
  }

  /** 精确读取指定 Provider 实例中模型的向量维度，禁止跨 Provider 猜测。 */
  dimFor(providerConfigId: string, model: string): number | undefined {
    const row = this.db
      .prepare(`SELECT dim FROM provider_embed_models
                WHERE provider_config_id = ? AND model = ?`)
      .get(providerConfigId, model) as { dim: number } | undefined;
    return row?.dim;
  }

  upsert(input: ProviderEmbedModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_embed_models
           (provider_config_id, model, dim, dim_source, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO UPDATE SET
           dim        = excluded.dim,
           dim_source = excluded.dim_source`,
      )
      .run(input.providerConfigId, input.model, input.dim, input.dimSource ?? 'table', Date.now());
  }

  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_embed_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
