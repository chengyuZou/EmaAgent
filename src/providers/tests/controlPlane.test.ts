// 测试自定义连接解析、跨预设协议选择和模型绑定只依赖已启用模型事实。
import { describe, expect, it } from 'vitest';
import {
  ModelBindings,
  ProviderConfigurations,
  ProviderModels,
  providerCatalog,
  type ConfiguredProvider,
  type ModelBinding,
  type ProviderConfigurationStore,
  type ProviderHealth,
  type ProviderModel,
  type ProviderWithHealth,
  type SaveProviderConfiguration,
} from '../index.js';

class MemoryControlStore implements ProviderConfigurationStore {
  readonly providers = new Map<string, ConfiguredProvider>();
  readonly credentials = new Map<string, string>();
  get(id: string) { return this.providers.get(id); }
  getWithHealth(id: string): ProviderWithHealth | undefined {
    const config = this.get(id);
    return config ? { config, health: null } : undefined;
  }
  listWithHealth(): ProviderWithHealth[] {
    return [...this.providers.values()].map((config) => ({ config, health: null }));
  }
  revealCredential(id: string) { return this.credentials.get(id) ?? null; }
  save(input: SaveProviderConfiguration) {
    if (input.credential !== undefined) {
      if (input.credential === null) this.credentials.delete(input.id);
      else this.credentials.set(input.id, input.credential);
    }
    this.providers.set(input.id, {
      id: input.id,
      definitionId: input.definitionId,
      displayName: input.displayName,
      hasCredential: this.credentials.has(input.id),
      enabled: input.enabled,
      capabilities: input.capabilities,
    });
  }
  delete(id: string) { this.providers.delete(id); }
  recordHealth(_id: string, _health: ProviderHealth) {}
}

describe('Provider 控制面', () => {
  it('内置 Provider 能选择同能力的非预设协议', () => {
    const store = new MemoryControlStore();
    const bindings: ModelBinding[] = [];
    const control = new ProviderConfigurations(
      providerCatalog,
      store,
      { listByProviderConfig: (id) => bindings.filter((item) => item.providerConfigId === id) },
      () => 'provider-1',
    );

    control.create({
      definitionId: 'siliconflow',
      enabled: true,
      credential: 'secret',
      capabilities: [{
        capability: 'rerank',
        protocol: 'cohere-rerank',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }],
    });

    expect(control.resolveConnection('provider-1', 'rerank')).toEqual({
      protocol: 'cohere-rerank',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'secret',
    });
  });

  it('内置预设没有声明的协议必须显式填写地址', () => {
    const store = new MemoryControlStore();
    const control = new ProviderConfigurations(
      providerCatalog,
      store,
      { listByProviderConfig: () => [] },
      () => 'provider-1',
    );

    expect(() => control.create({
      definitionId: 'openai',
      enabled: true,
      capabilities: [{ capability: 'rerank', protocol: 'cohere-rerank' }],
    })).toThrow(/必须填写 baseUrl/);
  });

  it('模型绑定从统一模型事实中确认能力', () => {
    const configurations = new MemoryControlStore();
    configurations.providers.set('provider-1', {
      id: 'provider-1', definitionId: null, displayName: 'Custom', hasCredential: false,
      enabled: true,
      capabilities: [{ capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1', enabled: true }],
    });
    const modelRows = new Map<string, ProviderModel>();
    const modelStore = {
      get: (providerId: string, capability: ProviderModel['capability'], model: string) =>
        modelRows.get(`${providerId}/${capability}/${model}`),
      listByProvider: () => [], listByCapability: () => [],
      save: (model: ProviderModel) => modelRows.set(`${model.providerConfigId}/${model.capability}/${model.model}`, model),
      delete: () => {},
    };
    const models = new ProviderModels(configurations, modelStore);
    models.save({
      providerConfigId: 'provider-1', capability: 'llm', model: 'model-a',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });

    const rows = new Map<string, ModelBinding>();
    const bindings = new ModelBindings(modelStore, {
      get: (module) => rows.get(module),
      list: () => [...rows.values()],
      listByProviderConfig: (id) => [...rows.values()].filter((row) => row.providerConfigId === id),
      set: (binding) => rows.set(binding.module, binding),
      delete: (module) => { rows.delete(module); },
    });

    expect(bindings.set({ module: 'memory', providerConfigId: 'provider-1', model: 'model-a' }))
      .toMatchObject({ capability: 'llm' });
    expect(() => bindings.set({ module: 'vision', providerConfigId: 'provider-1', model: 'model-a' }))
      .toThrow(/vision/);
  });
});
