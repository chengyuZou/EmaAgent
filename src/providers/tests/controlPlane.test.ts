// 测试自建 Provider 创建、按能力隔离的 key 解析连接和模型绑定只依赖已启用模型事实。
import { describe, expect, it } from 'vitest';
import {
  ModelBindings,
  ProviderModels,
  Providers,
  type ModelBinding,
  type Provider,
  type ProviderInput,
  type ProviderKey,
  type ProviderModel,
  type ProviderStore,
} from '../index.js';

class MemoryProviderStore implements ProviderStore {
  readonly providers = new Map<string, Provider>();
  readonly keys = new Map<string, ProviderKey>();

  get(id: string) { return this.providers.get(id); }
  list() { return [...this.providers.values()]; }
  save(input: ProviderInput) {
    this.providers.set(input.id, {
      id: input.id,
      name: input.name,
      ...(input.iconId !== undefined ? { iconId: input.iconId } : {}),
      authType: input.authType,
      enabled: input.enabled,
      capabilities: input.capabilities,
      health: this.providers.get(input.id)?.health ?? [],
    });
    for (const newKey of input.newKeys ?? []) {
      this.keys.set(newKey.id, {
        id: newKey.id,
        providerId: input.id,
        capability: newKey.capability,
        keyValue: newKey.keyValue,
        createdAt: Date.now(),
      });
    }
  }
  delete(id: string) { this.providers.delete(id); }
  listKeys(providerId: string, capability: ProviderKey['capability']) {
    return [...this.keys.values()]
      .filter((key) => key.providerId === providerId && key.capability === capability)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  addKey(entry: { id: string; providerId: string; capability: ProviderKey['capability']; keyValue: string; createdAt: number }) {
    this.keys.set(entry.id, { ...entry });
    this.setActiveKey(entry.providerId, entry.capability, entry.id);
  }
  setActiveKey(providerId: string, capability: ProviderKey['capability'], keyId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) return;
    const target = provider.capabilities.find((entry) => entry.capability === capability);
    if (target) (target as { activeKeyId?: string }).activeKeyId = keyId;
  }
  deleteKey(keyId: string) { this.keys.delete(keyId); }
  latestKeyValue(providerId: string) {
    return [...this.keys.values()]
      .filter((key) => key.providerId === providerId)
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.keyValue;
  }
  recordHealth() {}
}

function createProviders(store: MemoryProviderStore, bindings: ModelBinding[] = []) {
  let seq = 0;
  return new Providers(
    store,
    { listByProvider: (id) => bindings.filter((item) => item.providerId === id) },
    () => `key-${++seq}`,
  );
}

describe('Provider 控制面', () => {
  it('自建 Provider 创建后按能力解析连接，key 来自该能力 active key', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);

    providers.create({
      id: 'my-gateway',
      name: 'My Gateway',
      authType: 'bearer',
      enabled: true,
      capabilities: [{
        capability: 'llm',
        protocol: 'openai-llm',
        baseUrl: 'https://gateway.example/v1',
        key: 'sk-gateway',
      }],
    });

    expect(providers.resolveConnection('my-gateway', 'llm')).toEqual({
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
      enabled: true,
      capabilities: [{
        capability: 'llm' as const,
        protocol: 'openai-llm' as const,
        baseUrl: 'https://gateway.example/v1',
      }],
    };
    providers.create(input);
    expect(() => providers.create(input)).toThrow(/已存在/);
  });

  it('TTS 加 key 不影响 LLM 的 active 指针；能力间 key 完全隔离', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'siliconflow-copy',
      name: 'SiliconFlow Copy',
      authType: 'bearer',
      enabled: true,
      capabilities: [
        { capability: 'llm', protocol: 'openai-llm', baseUrl: 'https://api.siliconflow.cn/v1', key: 'sk-llm-a' },
        { capability: 'tts', protocol: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1', key: 'sk-tts-a' },
      ],
    });

    providers.addKey('siliconflow-copy', 'tts', 'sk-tts-b');

    expect(providers.resolveConnection('siliconflow-copy', 'tts').apiKey).toBe('sk-tts-b');
    expect(providers.resolveConnection('siliconflow-copy', 'llm').apiKey).toBe('sk-llm-a');
  });

  it('空白创建必须显式填写协议与 baseUrl，不允许任何默认猜测', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);

    expect(() => providers.create({
      id: 'broken',
      name: 'Broken',
      authType: 'bearer',
      enabled: true,
      capabilities: [{ capability: 'llm', protocol: 'openai-llm' }],
    })).toThrow(/baseUrl/);
    expect(() => providers.create({
      id: 'broken-2',
      name: 'Broken',
      authType: 'bearer',
      enabled: true,
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
      enabled: true,
      capabilities: [{ capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' }],
    });

    const modelRows = new Map<string, ProviderModel>();
    const modelStore = {
      get: (providerId: string, capability: ProviderModel['capability'], modelId: string) =>
        modelRows.get(`${providerId}/${capability}/${modelId}`),
      listByProvider: () => [], listByCapability: () => [],
      save: (model: ProviderModel) => modelRows.set(`${model.providerId}/${model.capability}/${model.modelId}`, model),
      delete: () => {},
    };
    const models = new ProviderModels(store, modelStore);
    models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'model-a',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });

    const rows = new Map<string, ModelBinding>();
    const bindings = new ModelBindings(modelStore, {
      get: (module) => rows.get(module),
      list: () => [...rows.values()],
      listByProvider: (id) => [...rows.values()].filter((row) => row.providerId === id),
      set: (binding) => rows.set(binding.module, binding),
      delete: (module) => { rows.delete(module); },
    });

    expect(bindings.set({ module: 'memory', providerId: 'custom-main', modelId: 'model-a' }))
      .toMatchObject({ capability: 'llm' });
    expect(() => bindings.set({ module: 'vision', providerId: 'custom-main', modelId: 'model-a' }))
      .toThrow(/vision/);
  });
});
