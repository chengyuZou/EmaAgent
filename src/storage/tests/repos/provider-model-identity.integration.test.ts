// 测试统一 Provider 模型表保留复合身份、判别字段和三态能力。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ProviderModelsRepo, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('ProviderModelsRepo', () => {
  let database: Database;
  let models: ProviderModelsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    const providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
    for (const id of ['provider-a', 'provider-b']) {
      providers.save({
        id,
        providerId: null,
        displayName: id,
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
      providerConfigId: 'provider-a', capability: 'llm', model: 'shared',
      contextWindow: 128_000, maxOutput: 16_000, toolCall: true,
      reasoning: true, temperature: null, inputImage: true,
    });
    models.save({
      providerConfigId: 'provider-b', capability: 'llm', model: 'shared',
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
    models.save({ providerConfigId: 'provider-a', capability: 'embed', model: 'embed', dim: 1_536 });
    models.save({ providerConfigId: 'provider-a', capability: 'rerank', model: 'rerank', maxChunks: 100 });
    models.save({ providerConfigId: 'provider-a', capability: 'vision', model: 'vision' });
    models.save({ providerConfigId: 'provider-a', capability: 'tts', model: 'tts' });
    models.save({ providerConfigId: 'provider-a', capability: 'stt', model: 'stt' });

    expect(models.listByProvider('provider-a').map((row) => row.capability))
      .toEqual(['embed', 'rerank', 'stt', 'tts', 'vision']);
    expect(models.get('provider-a', 'embed', 'embed')).toMatchObject({ dim: 1_536 });
    expect(models.get('provider-a', 'rerank', 'rerank')).toMatchObject({ maxChunks: 100 });
  });

  it('SQLite 约束拒绝能力与字段形状不一致的行', () => {
    expect(() => database.sqlite.prepare(
      `INSERT INTO provider_models
         (provider_config_id, capability, model, context_window, embedding_dim, created_at, updated_at)
       VALUES ('provider-a', 'embed', 'broken', 100, 10, 1, 1)`,
    ).run()).toThrow(/CHECK constraint failed/);
  });
});
