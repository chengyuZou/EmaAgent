// 测试每个业务模块只有一个绑定，并由统一模型外键保证能力和删除语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, ModelBindingsRepo, ProviderModelsRepo, ProvidersRepo } from '../../index.js';

describe('ModelBindingsRepo', () => {
  let database: Database;
  let bindings: ModelBindingsRepo;
  let models: ProviderModelsRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    new ProvidersRepo(database.sqlite).save({
      id: 'siliconflow',
      name: 'Provider',
      authType: 'bearer',
      capabilities: [
        { capability: 'llm', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://example.com/v1' }] },
        { capability: 'vision', activeProtocol: 'openai-llm', protocols: [{ protocol: 'openai-llm', baseUrl: 'https://example.com/v1' }] },
      ],
    });
    models = new ProviderModelsRepo(database.sqlite);
    models.save({
      providerId: 'siliconflow', capability: 'llm', modelId: 'old-model', source: 'user',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    models.save({
      providerId: 'siliconflow', capability: 'llm', modelId: 'new-model', source: 'user',
      contextWindow: 64_000, maxOutput: null, toolCall: true,
      reasoning: null, temperature: null, inputImage: null,
    });
    bindings = new ModelBindingsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('set 原子替换模块原有绑定', () => {
    bindings.set({ module: 'memory-llm', capability: 'llm', providerId: 'siliconflow', modelId: 'old-model' });
    bindings.set({ module: 'memory-llm', capability: 'llm', providerId: 'siliconflow', modelId: 'new-model' });

    expect(bindings.get('memory-llm')?.modelId).toBe('new-model');
    expect(bindings.list()).toHaveLength(1);
  });

  it('模块与能力不匹配时由 Schema 拒绝', () => {
    expect(() => bindings.set({
      module: 'vision', capability: 'llm', providerId: 'siliconflow', modelId: 'old-model',
    })).toThrow(/CHECK constraint failed/);
  });

  it('删除模型时级联删除对应绑定', () => {
    bindings.set({ module: 'memory-llm', capability: 'llm', providerId: 'siliconflow', modelId: 'old-model' });
    models.delete('siliconflow', 'llm', 'old-model');
    expect(bindings.get('memory-llm')).toBeUndefined();
  });
});
