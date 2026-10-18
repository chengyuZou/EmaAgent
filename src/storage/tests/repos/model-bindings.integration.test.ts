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
      provider: {
        id: 'siliconflow',
        name: 'Provider',
        icon_id: null,
        auth_type: 'bearer',
        key_value: null,
      },
      capabilities: [
        { provider_id: 'siliconflow', capability: 'llm', active_protocol: 'openai-llm', models_dev_id: null },
        { provider_id: 'siliconflow', capability: 'vision', active_protocol: 'openai-llm', models_dev_id: null },
      ],
      protocols: [
        { provider_id: 'siliconflow', capability: 'llm', protocol: 'openai-llm', base_url: 'https://example.com/v1' },
        { provider_id: 'siliconflow', capability: 'vision', protocol: 'openai-llm', base_url: 'https://example.com/v1' },
      ],
    });
    models = new ProviderModelsRepo(database.sqlite);
    models.save({
      provider_id: 'siliconflow', capability: 'llm', model_id: 'old-model', name: null, source: 'user', enabled: 1,
      context_window: 32_000, max_output: null, tool_call: null,
      reasoning: null, temperature: null, input_image: null, embedding_dim: null, rerank_max_chunks: null,
    });
    models.save({
      provider_id: 'siliconflow', capability: 'llm', model_id: 'new-model', name: null, source: 'user', enabled: 1,
      context_window: 64_000, max_output: null, tool_call: 1,
      reasoning: null, temperature: null, input_image: null, embedding_dim: null, rerank_max_chunks: null,
    });
    bindings = new ModelBindingsRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('set 原子替换模块原有绑定', () => {
    bindings.set({ module: 'memory-llm', capability: 'llm', provider_id: 'siliconflow', model_id: 'old-model' });
    bindings.set({ module: 'memory-llm', capability: 'llm', provider_id: 'siliconflow', model_id: 'new-model' });

    expect(bindings.get('memory-llm')?.model_id).toBe('new-model');
    expect(bindings.list()).toHaveLength(1);
  });

  it('模块与能力不匹配时由 Schema 拒绝', () => {
    expect(() => bindings.set({
      module: 'vision', capability: 'llm', provider_id: 'siliconflow', model_id: 'old-model',
    })).toThrow(/CHECK constraint failed/);
  });

  it('删除模型时级联删除对应绑定', () => {
    bindings.set({ module: 'memory-llm', capability: 'llm', provider_id: 'siliconflow', model_id: 'old-model' });
    models.delete('siliconflow', 'llm', 'old-model');
    expect(bindings.get('memory-llm')).toBeUndefined();
  });
});

