// 测试统一 Provider 模型表保留复合身份、判别字段和三态能力。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProviderModelsRepo, ProvidersRepo } from '../../index.js';

describe('ProviderModelsRepo', () => {
  let database: Database;
  let models: ProviderModelsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    const providers = new ProvidersRepo(database.sqlite);
    for (const id of ['provider-a', 'provider-b']) {
      providers.save({
        id,
        name: id,
        authType: 'bearer',
        enabled: true,
        capabilities: [
          { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://example.com/v1' }] },
          { capability: 'embed', activeProtocol: 'openai-embed', protocols: [{ protocol: 'openai-embed', baseUrl: 'https://example.com/v1' }] },
          { capability: 'rerank', activeProtocol: 'cohere-rerank', protocols: [{ protocol: 'cohere-rerank', baseUrl: 'https://example.com/v1' }] },
          { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://example.com/v1' }] },
          { capability: 'tts', activeProtocol: 'openai-tts', protocols: [{ protocol: 'openai-tts', baseUrl: 'https://example.com/v1' }] },
          { capability: 'stt', activeProtocol: 'openai-stt', protocols: [{ protocol: 'openai-stt', baseUrl: 'https://example.com/v1' }] },
        ],
      });
    }
    models = new ProviderModelsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('同名 LLM 按 Provider 精确保留不同模型事实', () => {
    models.save({
      providerId: 'provider-a', capability: 'llm', modelId: 'shared',
      contextWindow: 128_000, maxOutput: 16_000, toolCall: true,
      reasoning: true, temperature: null, inputImage: true,
    });
    models.save({
      providerId: 'provider-b', capability: 'llm', modelId: 'shared',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: false, temperature: true, inputImage: false,
    });

    expect(models.get('provider-a', 'llm', 'shared')).toMatchObject({
      contextWindow: 128_000, toolCall: true, temperature: null,
    });
    expect(models.get('provider-b', 'llm', 'shared')).toMatchObject({
      contextWindow: 32_000, toolCall: null, reasoning: false,
    });
  });

  it('六类模型从同一表恢复为对应判别联合', () => {
    models.save({ providerId: 'provider-a', capability: 'embed', modelId: 'embed', dim: 1_536 });
    models.save({ providerId: 'provider-a', capability: 'rerank', modelId: 'rerank', maxChunks: 100 });
    models.save({ providerId: 'provider-a', capability: 'vision', modelId: 'vision', contextWindow: 128_000, maxOutput: null, toolCall: null, reasoning: null, temperature: null, inputImage: true });
    models.save({ providerId: 'provider-a', capability: 'tts', modelId: 'tts' });
    models.save({ providerId: 'provider-a', capability: 'stt', modelId: 'stt' });

    expect(models.listByProvider('provider-a').map((row) => row.capability))
      .toEqual(['embed', 'rerank', 'stt', 'tts', 'vision']);
    expect(models.get('provider-a', 'embed', 'embed')).toMatchObject({ dim: 1_536 });
    expect(models.get('provider-a', 'rerank', 'rerank')).toMatchObject({ maxChunks: 100 });
  });

  it('SQLite 约束拒绝能力与字段形状不一致的行', () => {
    expect(() => database.sqlite.prepare(
      `INSERT INTO provider_models
         (provider_id, capability, model_id, context_window, embedding_dim, created_at, updated_at)
       VALUES ('provider-a', 'embed', 'broken', 100, 10, 1, 1)`,
    ).run()).toThrow(/CHECK constraint failed/);
  });
});
