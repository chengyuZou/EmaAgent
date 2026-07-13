import type { SqliteDb } from '../database.js';

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type ContextSource = 'live' | 'table' | 'manual';

export interface ProviderLlmModelRow {
  provider_config_id: string;
  model:              string;
  context_window:     number;
  context_source:     ContextSource;
  created_at:         number;
  /** 从 provider_configs JOIN 而来,用于 capability 查询(modelsDevId)。 */
  definition_id:      string | null;
}

export interface ProviderLlmModelInsert {
  providerConfigId: string;
  model:            string;
  contextWindow:    number;
  contextSource?:   ContextSource;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Per-provider 的已启用 LLM 模型池。一行 ⟺ 用户为该 provider config 开启了该模型。
 * `model_bindings`(per module)从此池取;禁用模型会级联到其 binding(在 providers 路由处理)。
 */
export class ProviderLlmModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 按 provider 查询 ────────────────────────────────────────────────────────

  /** 某 provider config 的已启用模型,驱动 provider 页面列表。 */
  listByProvider(providerConfigId: string): ProviderLlmModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_llm_models
                WHERE provider_config_id = ?
                ORDER BY created_at ASC, model ASC`)
      .all(providerConfigId) as ProviderLlmModelRow[];
  }

  // ── 按 model 查询 ───────────────────────────────────────────────────────────

  /**
   * 所有启用了该模型的 provider,驱动前端 model picker
   * (同名模型可能存在于多个 provider config 下)。
   * JOIN definition_id,供调用方解析 modelsDevId 做 capability 检查。
   */
  listByModel(model: string): ProviderLlmModelRow[] {
    return this.db
      .prepare(`SELECT plm.*, pc.definition_id
                FROM provider_llm_models plm
                JOIN provider_configs pc ON pc.id = plm.provider_config_id
                WHERE plm.model = ?
                ORDER BY plm.provider_config_id`)
      .all(model) as ProviderLlmModelRow[];
  }

  // ── 精确查询 ───────────────────────────────────────────────────────────────

  /** 返回指定已启用模型的完整行(含 definition_id)。 */
  get(providerConfigId: string, model: string): ProviderLlmModelRow | undefined {
    return this.db
      .prepare(`SELECT plm.*, pc.definition_id
                FROM provider_llm_models plm
                JOIN provider_configs pc ON pc.id = plm.provider_config_id
                WHERE plm.provider_config_id = ? AND plm.model = ?`)
      .get(providerConfigId, model) as ProviderLlmModelRow | undefined;
  }

  // ── 整个池 ─────────────────────────────────────────────────────────────────

  /** 所有 provider 的全部已启用模型。 */
  listAll(): ProviderLlmModelRow[] {
    return this.db
      .prepare(`SELECT * FROM provider_llm_models
                ORDER BY provider_config_id ASC, created_at ASC, model ASC`)
      .all() as ProviderLlmModelRow[];
  }

  /** 所有已启用模型,附带 provider display_name(供 ModelPicker 用)。 */
  listAllWithProvider(): Array<ProviderLlmModelRow & { display_name: string }> {
    return this.db
      .prepare(`SELECT plm.*, pc.display_name, pc.definition_id
                FROM provider_llm_models plm
                JOIN provider_configs pc ON pc.id = plm.provider_config_id
                ORDER BY pc.display_name ASC, plm.model ASC, plm.provider_config_id ASC`)
      .all() as Array<ProviderLlmModelRow & { display_name: string }>;
  }

  // ── 存在性检查 ─────────────────────────────────────────────────────────────

  /** 检查特定 (provider, model) 对是否已启用。 */
  hasProviderModel(providerConfigId: string, model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_llm_models WHERE provider_config_id = ? AND model = ?')
      .get(providerConfigId, model) !== undefined;
  }

  /** 检查是否有任意 provider 启用了该模型。 */
  hasModel(model: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM provider_llm_models WHERE model = ?')
      .get(model) !== undefined;
  }

  /**
   * 精确读取指定 Provider 实例中模型的 context window。
   * model 名不是全局身份；同名模型在不同 Provider 下可能具有不同限制。
   */
  contextWindowFor(providerConfigId: string, model: string): number | undefined {
    const row = this.db
      .prepare(`SELECT context_window FROM provider_llm_models
                WHERE provider_config_id = ? AND model = ?`)
      .get(providerConfigId, model) as { context_window: number } | undefined;
    return row?.context_window;
  }

  /** 启用模型(或更新其 context window)。 */
  upsert(input: ProviderLlmModelInsert): void {
    this.db
      .prepare(
        `INSERT INTO provider_llm_models
           (provider_config_id, model, context_window, context_source, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_config_id, model) DO UPDATE SET
           context_window = excluded.context_window,
           context_source = excluded.context_source`,
      )
      .run(
        input.providerConfigId,
        input.model,
        input.contextWindow,
        input.contextSource ?? 'table',
        Date.now(),
      );
  }

  /** 禁用模型。移除了行则返回 true。 */
  remove(providerConfigId: string, model: string): boolean {
    const info = this.db
      .prepare('DELETE FROM provider_llm_models WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes > 0;
  }
}
