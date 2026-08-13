// 测试每个业务模块只有一个绑定，并由统一模型外键保证能力和删除语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ModelBindingsRepo, ProviderModelsRepo, ProvidersRepo } from '../../index.js';
import { createTestCredentialFacade } from '../helpers/test-credential-facade.js';

describe('ModelBindingsRepo', () => {
  let database: Database;
  let bindings: ModelBindingsRepo;
  let models: ProviderModelsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    new ProvidersRepo(database.sqlite, createTestCredentialFacade()).save({
      id: 'provider-1',
      providerId: 'siliconflow',
      displayName: 'Provider',
      credential: 'secret',
      enabled: true,
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://example.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-vision', protocols: [{ protocol: 'openai-vision', baseUrl: 'https://example.com/v1' }] },
      ],
    });
    models = new ProviderModelsRepo(database.sqlite);
    models.save({
      providerConfigId: 'provider-1', capability: 'llm', model: 'old-model',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    models.save({
      providerConfigId: 'provider-1', capability: 'llm', model: 'new-model',
      contextWindow: 64_000, maxOutput: null, toolCall: true,
      reasoning: null, temperature: null, inputImage: null,
    });
    bindings = new ModelBindingsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('set 原子替换模块原有绑定', () => {
    bindings.set({ module: 'memory', capability: 'llm', providerConfigId: 'provider-1', model: 'old-model' });
    bindings.set({ module: 'memory', capability: 'llm', providerConfigId: 'provider-1', model: 'new-model' });

    expect(bindings.get('memory')?.model).toBe('new-model');
    expect(bindings.list()).toHaveLength(1);
  });

  it('模块与能力不匹配时由 Schema 拒绝', () => {
    expect(() => bindings.set({
      module: 'vision', capability: 'llm', providerConfigId: 'provider-1', model: 'old-model',
    })).toThrow(/CHECK constraint failed/);
  });

  it('删除模型时级联删除对应绑定', () => {
    bindings.set({ module: 'memory', capability: 'llm', providerConfigId: 'provider-1', model: 'old-model' });
    models.delete('provider-1', 'llm', 'old-model');
    expect(bindings.get('memory')).toBeUndefined();
  });
});
