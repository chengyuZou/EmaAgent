// Store model binding rows; model deletion cascades through the foreign key.
import type { ModelCapabilityRow } from './providers.js';
import type { SqliteDb } from '../../database/database.js';

export type ModelBindingModuleRow =
  'memory-llm' | 'narrative-embed' | 'narrative-llm' | 'tts' | 'stt' | 'vision';

export interface ModelBindingRow {
  module: ModelBindingModuleRow;
  capability: ModelCapabilityRow;
  provider_id: string;
  model_id: string;
}

export class ModelBindingsRepo {
  constructor(private readonly db: SqliteDb) {}

  get(module: ModelBindingModuleRow): ModelBindingRow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM model_bindings WHERE module = ?',
    ).get(module) as ModelBindingRow | undefined;
    return row;
  }

  list(): ModelBindingRow[] {
    return this.db.prepare(
      'SELECT * FROM model_bindings ORDER BY module ASC',
    ).all() as ModelBindingRow[];
  }

  listByProvider(providerId: string): ModelBindingRow[] {
    return this.db.prepare(
      `SELECT * FROM model_bindings
       WHERE provider_id = ? ORDER BY module ASC`,
    ).all(providerId) as ModelBindingRow[];
  }

  set(binding: ModelBindingRow): void {
    this.db.prepare(
      `INSERT INTO model_bindings (module, capability, provider_id, model_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module) DO UPDATE SET
         capability = excluded.capability,
         provider_id = excluded.provider_id,
         model_id = excluded.model_id`,
    ).run(binding.module, binding.capability, binding.provider_id, binding.model_id);
  }

  delete(module: ModelBindingModuleRow): void {
    this.db.prepare('DELETE FROM model_bindings WHERE module = ?').run(module);
  }
}
