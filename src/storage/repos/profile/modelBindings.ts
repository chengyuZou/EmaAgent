// 持久化每个业务模块唯一的模型绑定；模型删除时由外键自动清理绑定。
import type {
  ModelBinding,
  ModelBindingModule,
  ModelBindingStore,
} from '@ema-agent/provider';
import type { ModelCapability } from '@ema-agent/provider';
import type { SqliteDb } from '../../database/database.js';

interface ModelBindingRow {
  module: ModelBindingModule;
  capability: ModelCapability;
  provider_config_id: string;
  model: string;
}

export class ModelBindingsRepo implements ModelBindingStore {
  constructor(private readonly db: SqliteDb) {}

  get(module: ModelBindingModule): ModelBinding | undefined {
    const row = this.db.prepare(
      'SELECT * FROM model_bindings WHERE module = ?',
    ).get(module) as ModelBindingRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): ModelBinding[] {
    const rows = this.db.prepare(
      'SELECT * FROM model_bindings ORDER BY module ASC',
    ).all() as ModelBindingRow[];
    return rows.map(fromRow);
  }

  listByProviderConfig(providerConfigId: string): ModelBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM model_bindings
       WHERE provider_config_id = ? ORDER BY module ASC`,
    ).all(providerConfigId) as ModelBindingRow[];
    return rows.map(fromRow);
  }

  set(binding: ModelBinding): void {
    this.db.prepare(
      `INSERT INTO model_bindings (module, capability, provider_config_id, model)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module) DO UPDATE SET
         capability = excluded.capability,
         provider_config_id = excluded.provider_config_id,
         model = excluded.model`,
    ).run(binding.module, binding.capability, binding.providerConfigId, binding.model);
  }

  delete(module: ModelBindingModule): void {
    this.db.prepare('DELETE FROM model_bindings WHERE module = ?').run(module);
  }
}

function fromRow(row: ModelBindingRow): ModelBinding {
  return {
    module: row.module,
    capability: row.capability,
    providerConfigId: row.provider_config_id,
    model: row.model,
  };
}
