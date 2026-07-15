import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Database,
  ProviderEmbedModelsRepo,
  ProviderLlmModelsRepo,
  ProviderRerankModelsRepo,
  ProviderSttModelsRepo,
  ProviderTtsModelsRepo,
  ProviderVisionModelsRepo,
  ProvidersRepo,
} from '../../src/index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('N-008 Provider + Model 复合身份', () => {
  let database: Database;
  let llmModels: ProviderLlmModelsRepo;
  let embedModels: ProviderEmbedModelsRepo;
  let rerankModels: ProviderRerankModelsRepo;
  let ttsModels: ProviderTtsModelsRepo;
  let sttModels: ProviderSttModelsRepo;
  let visionModels: ProviderVisionModelsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();

    const providers = new ProvidersRepo(database.sqlite, createTestCredentialFacade());
    providers.upsert({
      id: 'provider-a',
      definitionId: 'provider-a',
      displayName: 'Provider A',
      capabilities: ['llm', 'embed', 'rerank', 'tts', 'stt', 'vision'],
    });
    providers.upsert({
      id: 'provider-b',
      definitionId: 'provider-b',
      displayName: 'Provider B',
      capabilities: ['llm', 'embed', 'rerank', 'tts', 'stt', 'vision'],
    });

    llmModels = new ProviderLlmModelsRepo(database.sqlite);
    embedModels = new ProviderEmbedModelsRepo(database.sqlite);
    rerankModels = new ProviderRerankModelsRepo(database.sqlite);
    ttsModels = new ProviderTtsModelsRepo(database.sqlite);
    sttModels = new ProviderSttModelsRepo(database.sqlite);
    visionModels = new ProviderVisionModelsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('同名 LLM 按 Provider 精确返回各自 context window', () => {
    llmModels.upsert({
      providerConfigId: 'provider-a',
      model: 'shared-model',
      contextWindow: 128_000,
    });
    llmModels.upsert({
      providerConfigId: 'provider-b',
      model: 'shared-model',
      contextWindow: 32_000,
    });

    expect(llmModels.contextWindowFor('provider-a', 'shared-model')).toBe(128_000);
    expect(llmModels.contextWindowFor('provider-b', 'shared-model')).toBe(32_000);
    expect(llmModels.contextWindowFor('missing-provider', 'shared-model')).toBeUndefined();
  });

  it('同名 Embedding 模型按 Provider 精确返回各自维度', () => {
    embedModels.upsert({
      providerConfigId: 'provider-a',
      model: 'shared-embed',
      dim: 1_536,
    });
    embedModels.upsert({
      providerConfigId: 'provider-b',
      model: 'shared-embed',
      dim: 3_072,
    });

    expect(embedModels.dimFor('provider-a', 'shared-embed')).toBe(1_536);
    expect(embedModels.dimFor('provider-b', 'shared-embed')).toBe(3_072);
    expect(embedModels.dimFor('missing-provider', 'shared-embed')).toBeUndefined();
  });

  it('同名 Rerank 模型保留各 Provider 的 maxChunks', () => {
    rerankModels.upsert({
      providerConfigId: 'provider-a',
      model: 'shared-rerank',
      maxChunks: 100,
    });
    rerankModels.upsert({
      providerConfigId: 'provider-b',
      model: 'shared-rerank',
      maxChunks: 500,
    });

    expect(rerankModels.get('provider-a', 'shared-rerank')?.max_chunks).toBe(100);
    expect(rerankModels.get('provider-b', 'shared-rerank')?.max_chunks).toBe(500);
  });

  it('TTS、STT、Vision 同名模型都保留 Provider 复合身份', () => {
    const pools = [ttsModels, sttModels, visionModels];
    for (const pool of pools) {
      pool.upsert({ providerConfigId: 'provider-a', model: 'shared-media-model' });
      pool.upsert({ providerConfigId: 'provider-b', model: 'shared-media-model' });

      expect(pool.get('provider-a', 'shared-media-model')?.provider_config_id)
        .toBe('provider-a');
      expect(pool.get('provider-b', 'shared-media-model')?.provider_config_id)
        .toBe('provider-b');
      expect(pool.listByModel('shared-media-model').map((row) => row.provider_config_id))
        .toEqual(['provider-a', 'provider-b']);
    }
  });

  it('六类模型池在同毫秒写入时都按 model 稳定排序', () => {
    llmModels.upsert({ providerConfigId: 'provider-a', model: 'z-model', contextWindow: 1 });
    llmModels.upsert({ providerConfigId: 'provider-a', model: 'a-model', contextWindow: 1 });
    embedModels.upsert({ providerConfigId: 'provider-a', model: 'z-model', dim: 1 });
    embedModels.upsert({ providerConfigId: 'provider-a', model: 'a-model', dim: 1 });
    rerankModels.upsert({ providerConfigId: 'provider-a', model: 'z-model' });
    rerankModels.upsert({ providerConfigId: 'provider-a', model: 'a-model' });
    ttsModels.upsert({ providerConfigId: 'provider-a', model: 'z-model' });
    ttsModels.upsert({ providerConfigId: 'provider-a', model: 'a-model' });
    sttModels.upsert({ providerConfigId: 'provider-a', model: 'z-model' });
    sttModels.upsert({ providerConfigId: 'provider-a', model: 'a-model' });
    visionModels.upsert({ providerConfigId: 'provider-a', model: 'z-model' });
    visionModels.upsert({ providerConfigId: 'provider-a', model: 'a-model' });

    for (const table of [
      'provider_llm_models',
      'provider_embed_models',
      'provider_rerank_models',
      'provider_tts_models',
      'provider_stt_models',
      'provider_vision_models',
    ]) {
      database.sqlite.prepare(`UPDATE ${table} SET created_at = 100`).run();
    }

    for (const rows of [
      llmModels.listByProvider('provider-a'),
      embedModels.listByProvider('provider-a'),
      rerankModels.listByProvider('provider-a'),
      ttsModels.listByProvider('provider-a'),
      sttModels.listByProvider('provider-a'),
      visionModels.listByProvider('provider-a'),
    ]) {
      expect(rows.map((row) => row.model)).toEqual(['a-model', 'z-model']);
    }
  });
});
