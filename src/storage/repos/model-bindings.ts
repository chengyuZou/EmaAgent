// 持久化业务模块到 Provider 模型的绑定，并保证单选替换在同一事务内完成。
import type {
  ModelBindingInput,
  ModelBindingModule,
  ResolvedModelBinding,
} from '@ema-agent/provider';
import type { SqliteDb } from '../database.js';

interface ModelBindingRow {
  module:             ModelBindingModule;
  provider_config_id: string;
  model:              string;
  embedding_dimension: number | null;
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
 *   router → siliconflow / Qwen-72B   （第一行 = engine 默认）
 *   router → deepseek    / deepseek-v3
 *   tts    → openai      / gpt-4o
 */
export class ModelBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 写入──────────────────────────────────────────────────────────────────

  /** 插入绑定。(module, provider_config_id, model) 冲突时更新该行。 */
  upsert(data: ModelBindingInput): void {
    this.db
      .prepare(
        `INSERT INTO model_bindings
           (module, provider_config_id, model, embedding_dimension)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(module, provider_config_id, model) DO UPDATE SET
           embedding_dimension = excluded.embedding_dimension`,
      )
      .run(
        data.module,
        data.providerConfigId,
        data.model,
        data.embeddingDimension ?? null,
      );
  }

  /** 删除单个绑定。 */
  delete(module: ModelBindingModule, providerConfigId: string, model: string): void {
    this.db
      .prepare('DELETE FROM model_bindings WHERE module = ? AND provider_config_id = ? AND model = ?')
      .run(module, providerConfigId, model);
  }

  /** 删除某模块的所有绑定。用于单选原子替换。 */
  deleteAllByModule(module: ModelBindingModule): number {
    const info = this.db
      .prepare('DELETE FROM model_bindings WHERE module = ?')
      .run(module);
    return info.changes;
  }

  /**
   * 单选原子替换：先删除该模块的全部绑定，再插入新绑定，两步在同一事务内。
   * 用于 PUT /:module/set 路由。若 upsert 失败（如外键冲突、磁盘错误），
   * 事务回滚，旧绑定保留——避免模块瞬间失去全部绑定导致配置丢失。
   */
  setSingle(data: ModelBindingInput): void {
    this.db.transaction(() => {
      this.deleteAllByModule(data.module);
      this.upsert(data);
    })();
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

  /**
   * 返回某模块的第一个绑定（engine 用作默认值）。
   * 按 (provider_config_id, model) 稳定排序，保证多候选时默认绑定确定不跳变。
   */
  get(module: ModelBindingModule): ResolvedModelBinding | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM model_bindings
         WHERE module = ?
         ORDER BY provider_config_id ASC, model ASC
         LIMIT 1`,
      )
      .get(module) as ModelBindingRow | undefined;
    return row ? this.resolve(row) : undefined;
  }

  /** 返回某模块的所有绑定（UI 列表用），按 (provider_config_id, model) 稳定排序。 */
  listByModule(module: ModelBindingModule): ResolvedModelBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM model_bindings
         WHERE module = ?
         ORDER BY provider_config_id ASC, model ASC`,
      )
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
      embeddingDimension: row.embedding_dimension,
    };
  }
}
