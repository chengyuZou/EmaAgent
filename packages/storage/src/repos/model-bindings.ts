import type { SqliteDb } from '../database.js';

// ── 类型─────────────────────────────────────────────────────────────────────

/** 所有可绑定到特定 Provider 实例 + model 的模块。 */
export type BindingModule =
  // 基础设施 / 后台任务 — 仍需全局绑定
  | 'emotion'
  | 'memory'
  | 'router' | 'plan-parse' | 'title'
  // LightRAG 内部配置 — 推送到 Python bridge。KB embed/rerank 已
  // 移出到 app settings (kb.models)；此处仅保留 LightRAG 的 embed。
  | 'lightrag-embed' | 'lightrag-llm'
  // TTS — 所有模式共用一个绑定
  | 'tts'
  // 其他 TS 侧客户端（保留）
  | 'stt' | 'vision' | 'imagegen';

export interface ModelBindingRow {
  module:             BindingModule;
  provider_config_id: string;
  model:              string;
  voice_id:           string | null;
  config_json:        string;
}

export interface ModelBindingUpsert {
  module:           BindingModule;
  providerConfigId: string;
  model:            string;
  voiceId?:         string;
  config?:          Record<string, unknown>;
}

/** 已解析 config_json 的绑定结果。 */
export interface ResolvedModelBinding {
  module:           BindingModule;
  providerConfigId: string;
  model:            string;
  voiceId:          string | null;
  config:           Record<string, unknown>;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * 管理每个模块使用哪个 Provider 实例 + model。
 *
 * 每个模块可有多个绑定（如 chat 可同时绑定 deepseek-v3 和
 * qwen-72b 作为候选）。engine 使用某模块的第一行
 * （由 `get()` 返回）。UI 通过 `listByModule()` 列出所有行。
 *
 * 唯一键：(module, provider_config_id, model)。
 *
 * 示例：
 *   chat  → siliconflow / Qwen-72B   （第一行 = engine 默认）
 *   chat  → deepseek    / deepseek-v3
 *   agent → openai      / gpt-4o
 */
export class ModelBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 写入──────────────────────────────────────────────────────────────────

  /** 插入绑定。(module, provider_config_id, model) 冲突时更新该行。 */
  upsert(data: ModelBindingUpsert): void {
    this.db
      .prepare(
        `INSERT INTO model_bindings
           (module, provider_config_id, model, voice_id, config_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(module, provider_config_id, model) DO UPDATE SET
           voice_id    = excluded.voice_id,
           config_json = excluded.config_json`,
      )
      .run(
        data.module,
        data.providerConfigId,
        data.model,
        data.voiceId ?? null,
        JSON.stringify(data.config ?? {}),
      );
  }

  /** 删除单个绑定。 */
  delete(module: BindingModule, providerConfigId: string, model: string): void {
    this.db
      .prepare('DELETE FROM model_bindings WHERE module = ? AND provider_config_id = ? AND model = ?')
      .run(module, providerConfigId, model);
  }

  /** 删除某模块的所有绑定。用于单选原子替换。 */
  deleteAllByModule(module: BindingModule): number {
    const info = this.db
      .prepare('DELETE FROM model_bindings WHERE module = ?')
      .run(module);
    return info.changes;
  }

  /**
   * 删除引用某 Provider+model 的所有绑定
   * （跨所有模块）。在 provider 页面禁用 model 时调用 —
   * 启用池中的该行已删除，故其绑定也需移除。返回
   * 删除的绑定数。
   */
  deleteByProviderModel(providerConfigId: string, model: string): number {
    const info = this.db
      .prepare('DELETE FROM model_bindings WHERE provider_config_id = ? AND model = ?')
      .run(providerConfigId, model);
    return info.changes;
  }

  // ── 读取───────────────────────────────────────────────────────────────────

  /** 返回某模块的第一个绑定（engine 用作默认值）。 */
  get(module: BindingModule): ResolvedModelBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM model_bindings WHERE module = ? LIMIT 1')
      .get(module) as ModelBindingRow | undefined;
    return row ? this.resolve(row) : undefined;
  }

  /** 返回某模块的所有绑定（UI 列表用）。 */
  listByModule(module: BindingModule): ResolvedModelBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM model_bindings WHERE module = ?')
      .all(module) as ModelBindingRow[];
    return rows.map(r => this.resolve(r));
  }

  /** 删除 Provider 前列出全部引用；供 API 返回可操作的 409 冲突信息。 */
  listByProviderConfig(providerConfigId: string): ResolvedModelBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM model_bindings
         WHERE provider_config_id = ?
         ORDER BY module ASC, model ASC`,
      )
      .all(providerConfigId) as ModelBindingRow[];
    return rows.map((row) => this.resolve(row));
  }

  /** 返回所有模块的全部绑定。 */
  list(): ResolvedModelBinding[] {
    const rows = this.db
      .prepare('SELECT * FROM model_bindings ORDER BY module ASC')
      .all() as ModelBindingRow[];
    return rows.map(r => this.resolve(r));
  }

  // ── 辅助方法────────────────────────────────────────────────────────────────

  private resolve(row: ModelBindingRow): ResolvedModelBinding {
    return {
      module:           row.module,
      providerConfigId: row.provider_config_id,
      model:            row.model,
      voiceId:          row.voice_id,
      config:           JSON.parse(row.config_json) as Record<string, unknown>,
    };
  }
}
