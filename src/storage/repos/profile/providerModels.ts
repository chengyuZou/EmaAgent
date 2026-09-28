// Store model rows without interpreting capability-specific business fields.
import type { SqliteDb } from '../../database/database.js';
import type { ModelCapabilityRow } from './providers.js';

export interface ProviderModelRow {
  provider_id: string;
  capability: ModelCapabilityRow;
  model_id: string;
  name: string | null;
  source: 'user' | 'dev';
  enabled: number;
  context_window: number | null;
  max_output: number | null;
  tool_call: number | null;
  reasoning: number | null;
  temperature: number | null;
  input_image: number | null;
  embedding_dim: number | null;
  rerank_max_chunks: number | null;
}

export class ProviderModelsRepo {
  constructor(private readonly db: SqliteDb) {}

  get(
    providerId: string,
    capability: ProviderModelRow['capability'],
    modelId: string,
  ): ProviderModelRow | undefined {
    const row = this.db.prepare(
      `SELECT * FROM provider_models
       WHERE provider_id = ? AND capability = ? AND model_id = ?`,
    ).get(providerId, capability, modelId) as ProviderModelRow | undefined;
    return row;
  }

  listByProvider(providerId: string, capability?: ProviderModelRow['capability']): ProviderModelRow[] {
    const rows = capability === undefined
      ? this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_id = ? ORDER BY capability ASC, model_id ASC`,
      ).all(providerId)
      : this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_id = ? AND capability = ? ORDER BY model_id ASC`,
      ).all(providerId, capability);
    return rows as ProviderModelRow[];
  }

  listByCapability(capability: ProviderModelRow['capability']): ProviderModelRow[] {
    return this.db.prepare(
      `SELECT * FROM provider_models
       WHERE capability = ? ORDER BY provider_id ASC, model_id ASC`,
    ).all(capability) as ProviderModelRow[];
  }

  hasAny(): boolean {
    return this.db.prepare(`SELECT 1 AS x FROM provider_models LIMIT 1`).get() !== undefined;
  }

  save(model: ProviderModelRow): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO provider_models
         (provider_id, capability, model_id, name, source, enabled, context_window, max_output,
          tool_call, reasoning, temperature, input_image, embedding_dim,
          rerank_max_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, capability, model_id) DO UPDATE SET
         name = excluded.name,
         source = excluded.source,
         context_window = excluded.context_window,
         max_output = excluded.max_output,
         tool_call = excluded.tool_call,
         reasoning = excluded.reasoning,
         temperature = excluded.temperature,
         input_image = excluded.input_image,
         embedding_dim = excluded.embedding_dim,
         rerank_max_chunks = excluded.rerank_max_chunks,
         updated_at = excluded.updated_at`,
    ).run(
      model.provider_id,
      model.capability,
      model.model_id,
      model.name,
      model.source,
      model.enabled,
      model.context_window,
      model.max_output,
      model.tool_call,
      model.reasoning,
      model.temperature,
      model.input_image,
      model.embedding_dim,
      model.rerank_max_chunks,
      now,
      now,
    );
  }

  setEnabled(providerId: string, capability: ProviderModelRow['capability'], modelId: string, enabled: number): void {
    this.db.prepare(
      `UPDATE provider_models SET enabled = ?, updated_at = ?
       WHERE provider_id = ? AND capability = ? AND model_id = ?`,
    ).run(enabled, Date.now(), providerId, capability, modelId);
  }

  delete(providerId: string, capability: ProviderModelRow['capability'], modelId: string): void {
    this.db.prepare(
      `DELETE FROM provider_models
       WHERE provider_id = ? AND capability = ? AND model_id = ?`,
    ).run(providerId, capability, modelId);
  }
}
