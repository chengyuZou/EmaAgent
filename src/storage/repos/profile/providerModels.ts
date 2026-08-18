// 在一张表中持久化六类模型，并在 Repo 边界恢复 ProviderModel 判别联合。
import type { ModelCapability, ProviderModel, ProviderModelStore } from '@ema-agent/providers';
import type { SqliteDb } from '../../database/database.js';

interface ProviderModelRow {
  provider_id: string;
  capability: ModelCapability;
  model_id: string;
  name: string | null;
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
    providerId: string,
    capability: ModelCapability,
    modelId: string,
  ): ProviderModel | undefined {
    const row = this.db.prepare(
      `SELECT * FROM provider_models
       WHERE provider_id = ? AND capability = ? AND model_id = ?`,
    ).get(providerId, capability, modelId) as ProviderModelRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  listByProvider(providerId: string, capability?: ModelCapability): ProviderModel[] {
    const rows = capability === undefined
      ? this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_id = ? ORDER BY capability ASC, model_id ASC`,
      ).all(providerId)
      : this.db.prepare(
        `SELECT * FROM provider_models
         WHERE provider_id = ? AND capability = ? ORDER BY model_id ASC`,
      ).all(providerId, capability);
    return (rows as ProviderModelRow[]).map(fromRow);
  }

  listByCapability(capability: ModelCapability): ProviderModel[] {
    const rows = this.db.prepare(
      `SELECT * FROM provider_models
       WHERE capability = ? ORDER BY provider_id ASC, model_id ASC`,
    ).all(capability) as ProviderModelRow[];
    return rows.map(fromRow);
  }

  save(model: ProviderModel): void {
    const now = Date.now();
    const fields = toColumns(model);
    this.db.prepare(
      `INSERT INTO provider_models
         (provider_id, capability, model_id, name, context_window, max_output,
          tool_call, reasoning, temperature, input_image, embedding_dim,
          rerank_max_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, capability, model_id) DO UPDATE SET
         name = excluded.name,
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
      model.providerId,
      model.capability,
      model.modelId,
      model.name ?? null,
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

  delete(providerId: string, capability: ModelCapability, modelId: string): void {
    this.db.prepare(
      `DELETE FROM provider_models
       WHERE provider_id = ? AND capability = ? AND model_id = ?`,
    ).run(providerId, capability, modelId);
  }
}

function fromRow(row: ProviderModelRow): ProviderModel {
  const identity = {
    providerId: row.provider_id,
    capability: row.capability,
    modelId: row.model_id,
    ...(row.name === null ? {} : { name: row.name }),
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
    case 'vision':
      return {
        ...identity,
        capability: 'vision',
        contextWindow: row.context_window!,
        maxOutput: row.max_output,
        toolCall: fromBoolean(row.tool_call),
        reasoning: fromBoolean(row.reasoning),
        temperature: fromBoolean(row.temperature),
        inputImage: fromBoolean(row.input_image),
      };
    case 'tts': return { ...identity, capability: 'tts' };
    case 'stt': return { ...identity, capability: 'stt' };
  }
}

function toColumns(model: ProviderModel) {
  const withWindow = model.capability === 'llm' || model.capability === 'vision';
  return {
    contextWindow: withWindow ? model.contextWindow : null,
    maxOutput: withWindow ? model.maxOutput : null,
    toolCall: withWindow ? toBoolean(model.toolCall) : null,
    reasoning: withWindow ? toBoolean(model.reasoning) : null,
    temperature: withWindow ? toBoolean(model.temperature) : null,
    inputImage: withWindow ? toBoolean(model.inputImage) : null,
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
