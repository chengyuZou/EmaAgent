// 在一张表中持久化六类模型，并在 Repo 边界恢复 ProviderModel 判别联合。
import type { Capability, ProviderModel, ProviderModelStore } from '@ema-agent/provider';
import type { SqliteDb } from '../../database/database.js';

interface ProviderModelRow {
  provider_config_id: string;
  capability: Capability;
  model: string;
  context_window: number | null;
  max_output: number | null;
  tool_call: number | null;
  reasoning: number | null;
  temperature: number | null;
  input_image: number | null;
  embedding_dim: number | null;
  rerank_max_chunks: number | null;
}

export class ProviderModelsRepo implements ProviderModelStore {
  constructor(private readonly db: SqliteDb) {}

  get(
    providerConfigId: string,
    capability: Capability,
    model: string,
  ): ProviderModel | undefined {
    const row = this.db.prepare(
      `SELECT * FROM provider_models
       WHERE provider_config_id = ? AND capability = ? AND model = ?`,
    ).get(providerConfigId, capability, model) as ProviderModelRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listByProvider(providerConfigId: string, capability?: Capability): ProviderModel[] {
    const rows = capability === undefined
      ? this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_config_id = ? ORDER BY capability ASC, model ASC`,
      ).all(providerConfigId)
      : this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_config_id = ? AND capability = ? ORDER BY model ASC`,
      ).all(providerConfigId, capability);
    return (rows as ProviderModelRow[]).map(fromRow);
  }

  listByCapability(capability: Capability): ProviderModel[] {
    const rows = this.db.prepare(
      `SELECT * FROM provider_models
       WHERE capability = ? ORDER BY provider_config_id ASC, model ASC`,
    ).all(capability) as ProviderModelRow[];
    return rows.map(fromRow);
  }

  save(model: ProviderModel): void {
    const now = Date.now();
    const fields = toColumns(model);
    this.db.prepare(
      `INSERT INTO provider_models
         (provider_config_id, capability, model, context_window, max_output,
          tool_call, reasoning, temperature, input_image, embedding_dim,
          rerank_max_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_config_id, capability, model) DO UPDATE SET
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
      model.providerConfigId,
      model.capability,
      model.model,
      fields.contextWindow,
      fields.maxOutput,
      fields.toolCall,
      fields.reasoning,
      fields.temperature,
      fields.inputImage,
      fields.embeddingDim,
      fields.rerankMaxChunks,
      now,
      now,
    );
  }

  delete(providerConfigId: string, capability: Capability, model: string): void {
    this.db.prepare(
      `DELETE FROM provider_models
       WHERE provider_config_id = ? AND capability = ? AND model = ?`,
    ).run(providerConfigId, capability, model);
  }
}

function fromRow(row: ProviderModelRow): ProviderModel {
  const identity = {
    providerConfigId: row.provider_config_id,
    capability: row.capability,
    model: row.model,
  };
  switch (row.capability) {
    case 'llm':
      return {
        ...identity,
        capability: 'llm',
        contextWindow: row.context_window!,
        maxOutput: row.max_output,
        toolCall: fromBoolean(row.tool_call),
        reasoning: fromBoolean(row.reasoning),
        temperature: fromBoolean(row.temperature),
        inputImage: fromBoolean(row.input_image),
      };
    case 'embed':
      return { ...identity, capability: 'embed', dim: row.embedding_dim! };
    case 'rerank':
      return { ...identity, capability: 'rerank', maxChunks: row.rerank_max_chunks };
    case 'vision': return { ...identity, capability: 'vision' };
    case 'tts': return { ...identity, capability: 'tts' };
    case 'stt': return { ...identity, capability: 'stt' };
  }
}

function toColumns(model: ProviderModel) {
  return {
    contextWindow: model.capability === 'llm' ? model.contextWindow : null,
    maxOutput: model.capability === 'llm' ? model.maxOutput : null,
    toolCall: model.capability === 'llm' ? toBoolean(model.toolCall) : null,
    reasoning: model.capability === 'llm' ? toBoolean(model.reasoning) : null,
    temperature: model.capability === 'llm' ? toBoolean(model.temperature) : null,
    inputImage: model.capability === 'llm' ? toBoolean(model.inputImage) : null,
    embeddingDim: model.capability === 'embed' ? model.dim : null,
    rerankMaxChunks: model.capability === 'rerank' ? model.maxChunks : null,
  };
}

function toBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function fromBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}
