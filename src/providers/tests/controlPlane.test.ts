// 测试自建 Provider 创建、一把 key 解析连接、update 的 key 语义与模型池来源事实。
import { describe, expect, it } from 'vitest';
import {
  ModelBindings,
  ProviderModels,
  Providers,
  type ModelBinding,
  type Provider,
  type ProviderInput,
  type ProviderModel,
  type ProviderStore,
} from '../index.js';

class MemoryProviderStore implements ProviderStore {
  readonly providers = new Map<string, Provider>();

  get(id: string) { return this.providers.get(id); }
  list() { return [...this.providers.values()]; }
  save(input: ProviderInput) {
    this.providers.set(input.id, {
      id: input.id,
      name: input.name,
      ...(input.iconId !== undefined ? { iconId: input.iconId } : {}),
      authType: input.authType,
      ...(input.keyValue !== undefined ? { keyValue: input.keyValue } : {}),
      capabilities: input.capabilities,
      health: this.providers.get(input.id)?.health ?? [],
    });
  }
  delete(id: string) { this.providers.delete(id); }
  recordHealth() {}
}

function createProviders(store: MemoryProviderStore, bindings: ModelBinding[] = []) {
  return new Providers(
    store,
    { listByProvider: (id) => bindings.filter((item) => item.providerId === id) },
  );
}

/** 模型池 + 绑定的内存接线。 */
function createModelStack(store: MemoryProviderStore) {
  const modelRows = new Map<string, ProviderModel>();
  const modelStore = {
    get: (providerId: string, capability: ProviderModel['capability'], modelId: string) =>
      modelRows.get(`${providerId}/${capability}/${modelId}`),
    listByProvider: () => [], listByCapability: () => [],
    save: (model: ProviderModel) => modelRows.set(`${model.providerId}/${model.capability}/${model.modelId}`, model),
    delete: (providerId: string, capability: ProviderModel['capability'], modelId: string) => {
      modelRows.delete(`${providerId}/${capability}/${modelId}`);
    },
  };
  const bindingRows = new Map<string, ModelBinding>();
  const bindingStore = {
    get: (module: ModelBinding['module']) => bindingRows.get(module),
    list: () => [...bindingRows.values()],
    listByProvider: (id: string) => [...bindingRows.values()].filter((row) => row.providerId === id),
    set: (binding: ModelBinding) => bindingRows.set(binding.module, binding),
    delete: (module: ModelBinding['module']) => { bindingRows.delete(module); },
  };
  return {
    models: new ProviderModels(store, modelStore),
    bindings: new ModelBindings(modelStore, bindingStore),
    plant: (model: ProviderModel) => {
      modelRows.set(`${model.providerId}/${model.capability}/${model.modelId}`, model);
    },
  };
}

describe('Provider 控制面', () => {
  it('自建 Provider 创建后按能力解析连接，key 来自 Provider 的一把 key', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);

    providers.create({
      id: 'my-gateway',
      name: 'My Gateway',
      authType: 'bearer',
      key: 'sk-gateway',
      capabilities: [{
        capability: 'llm',
        protocol: 'openai-llm',
        baseUrl: 'https://gateway.example/v1',
      }],
    });

    expect(providers.resolveConnection('my-gateway', 'llm')).toEqual({
      providerId: 'my-gateway',
      protocol: 'openai-llm',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-gateway',
    });
  });

  it('重复 id 创建被拒绝，内置种子 id 同样占用', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    const input = {
      id: 'my-gateway',
      name: 'My Gateway',
      authType: 'bearer' as const,
      capabilities: [{
        capability: 'llm' as const,
        protocol: 'openai-llm' as const,
        baseUrl: 'https://gateway.example/v1',
      }],
    };
    providers.create(input);
    expect(() => providers.create(input)).toThrow(/已存在/);
  });

  it('一个 Provider 一把 key：全能力共享；update 未提供 key 不动，null 清空', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'siliconflow-copy',
      name: 'SiliconFlow Copy',
      authType: 'bearer',
      key: 'sk-main',
      capabilities: [
        { capability: 'llm', protocol: 'openai-llm', baseUrl: 'https://api.siliconflow.cn/v1' },
        { capability: 'tts', protocol: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1' },
      ],
    });

    expect(providers.resolveConnection('siliconflow-copy', 'llm').apiKey).toBe('sk-main');
    expect(providers.resolveConnection('siliconflow-copy', 'tts').apiKey).toBe('sk-main');
    expect(providers.get('siliconflow-copy').keyValue).toBe('sk-main');

    providers.update('siliconflow-copy', { name: 'Renamed' });
    expect(providers.get('siliconflow-copy').keyValue).toBe('sk-main');

    providers.update('siliconflow-copy', { key: 'sk-next' });
    expect(providers.resolveConnection('siliconflow-copy', 'llm').apiKey).toBe('sk-next');

    providers.update('siliconflow-copy', { key: null });
    expect(providers.get('siliconflow-copy').keyValue).toBeUndefined();
    expect(() => providers.resolveConnection('siliconflow-copy', 'llm')).toThrow(/API Key/);
  });

  it('空白创建必须显式填写协议与 baseUrl，不允许任何默认猜测', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);

    expect(() => providers.create({
      id: 'broken',
      name: 'Broken',
      authType: 'bearer',
      capabilities: [{ capability: 'llm', protocol: 'openai-llm' }],
    })).toThrow(/baseUrl/);
    expect(() => providers.create({
      id: 'broken-2',
      name: 'Broken',
      authType: 'bearer',
      capabilities: [{ capability: 'llm', baseUrl: 'https://example.com' }],
    })).toThrow(/协议/);
  });

  it('模型绑定从统一模型事实中确认能力', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capabilities: [{ capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' }],
    });

    const { models, bindings } = createModelStack(store);
    models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'model-a',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });

    expect(bindings.set({ module: 'memory-llm', providerId: 'custom-main', modelId: 'model-a' }))
      .toMatchObject({ capability: 'llm' });
    expect(() => bindings.set({ module: 'vision', providerId: 'custom-main', modelId: 'model-a' }))
      .toThrow(/vision/);
  });

  it('来源语义：手动新增为 user，编辑种子保留 seed；seed 不可删、user 可删', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capabilities: [{ capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' }],
    });
    const { models, plant } = createModelStack(store);
    const input = {
      providerId: 'custom-main', capability: 'llm' as const, modelId: 'model-a',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    };

    expect(models.save(input).source).toBe('user');

    plant({ ...input, modelId: 'seed-a', source: 'seed' });
    models.save({ ...input, modelId: 'seed-a', contextWindow: 64_000 });
    expect(models.get('custom-main', 'llm', 'seed-a').source).toBe('seed');

    expect(() => models.delete('custom-main', 'llm', 'seed-a')).toThrow(/不能删除/);
    models.delete('custom-main', 'llm', 'model-a');
    expect(() => models.get('custom-main', 'llm', 'model-a')).toThrow(/不存在/);
  });
});
