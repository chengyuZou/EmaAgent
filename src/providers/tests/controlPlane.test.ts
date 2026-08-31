// 测试自建 Provider 创建（按能力分区、id 缺省生成）、一把 key 解析连接、update 的能力 delta 与目录落行。
import { describe, expect, it } from 'vitest';
import {
  ModelBindings,
  ModelsDevCatalog,
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

/** 测试目录：acme-pro 参数齐全；acme-nolimit 缺 contextWindow（不可落行）。 */
function createTestCatalog(): ModelsDevCatalog {
  const catalog = new ModelsDevCatalog();
  catalog.loadFromJson({
    acme: {
      models: {
        'acme-pro': {
          id: 'acme-pro', name: 'Acme Pro', reasoning: true, tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 128_000, output: 8_000 },
        },
        'acme-nolimit': { id: 'acme-nolimit' },
      },
    },
  });
  return catalog;
}

/** 模型池 + 绑定的内存接线。 */
function createModelStack(store: MemoryProviderStore) {
  const modelRows = new Map<string, ProviderModel>();
  const modelStore = {
    get: (providerId: string, capability: ProviderModel['capability'], modelId: string) =>
      modelRows.get(`${providerId}/${capability}/${modelId}`),
    listByProvider: () => [], listByCapability: () => [],
    save: (model: ProviderModel) => modelRows.set(`${model.providerId}/${model.capability}/${model.modelId}`, model),
    setEnabled: (providerId: string, capability: ProviderModel['capability'], modelId: string, enabled: boolean) => {
      const row = modelRows.get(`${providerId}/${capability}/${modelId}`);
      if (row) modelRows.set(`${providerId}/${capability}/${modelId}`, { ...row, enabled });
    },
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
    models: new ProviderModels(store, modelStore, createTestCatalog(), bindingStore),
    bindings: new ModelBindings(modelStore, bindingStore),
    modelRows,
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
      capability: {
        capability: 'llm',
        protocol: 'openai-llm',
        baseUrl: 'https://gateway.example/v1',
      },
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
      capability: {
        capability: 'llm' as const,
        protocol: 'openai-llm' as const,
        baseUrl: 'https://gateway.example/v1',
      },
    };
    providers.create(input);
    expect(() => providers.create(input)).toThrow(/已存在/);
  });

  it('id 是语义 slug：用户显式给定；非法/空值创建被拒', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);

    const created = providers.create({
      id: 'company-gateway',
      name: 'Company Gateway',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost:8000/v1' },
    });

    expect(created.id).toBe('company-gateway');
    expect(created.capabilities).toEqual([{
      capability: 'llm',
      activeProtocol: 'openai-llm',
      protocols: [{ protocol: 'openai-llm', baseUrl: 'http://localhost:8000/v1' }],
    }]);

    expect(() => providers.create({
      id: 'bad id!',
      name: 'Bad',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
    })).toThrow(/id/);
  });

  it('一个 Provider 一把 key：全能力共享；update 未提供 key 不动，null 清空', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'siliconflow-copy',
      name: 'SiliconFlow Copy',
      authType: 'bearer',
      key: 'sk-main',
      capability: {
        capability: 'llm',
        protocol: 'openai-llm',
        baseUrl: 'https://api.siliconflow.cn/v1',
      },
    });
    // 第二个能力走 update 追加（后端保留路径；不接 UI）
    providers.update('siliconflow-copy', {
      capability: { capability: 'tts', protocol: 'openai-tts', baseUrl: 'https://api.siliconflow.cn/v1' },
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
      capability: { capability: 'llm', protocol: 'openai-llm' },
    })).toThrow(/baseUrl/);
    expect(() => providers.create({
      id: 'broken-2',
      name: 'Broken',
      authType: 'bearer',
      capability: { capability: 'llm', baseUrl: 'https://example.com' },
    })).toThrow(/协议/);
  });

  it('模型绑定只接受已启用模型', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
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

    // 先解绑，再停用，之后新绑定被拒绝（只绑已启用）
    bindings.delete('memory-llm');
    models.setEnabled('custom-main', 'llm', 'model-a', false);
    expect(() => bindings.set({ module: 'title', providerId: 'custom-main', modelId: 'model-a' }))
      .toThrow(/已启用/);
  });

  it('手填：新增 user 行默认启用；dev 行禁修改', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
    });
    providers.update('custom-main', { capability: { capability: 'llm', modelsDevId: 'acme' } });
    const { models } = createModelStack(store);

    const manual = models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'self-hosted',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    expect(manual).toMatchObject({ source: 'user', enabled: true });

    models.syncDevModels('custom-main', 'llm');
    expect(() => models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'acme-pro',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    })).toThrow(/目录/);
  });

  it('目录同步：新 spec 默认禁用；已有 dev 行参数对齐（enabled 不动）；手写行不动', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
    });
    providers.update('custom-main', { capability: { capability: 'llm', modelsDevId: 'acme' } });
    const { models } = createModelStack(store);

    models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'acme-pro',
      contextWindow: 1_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });

    const synced = models.syncDevModels('custom-main', 'llm');
    // 手写行（source='user'）不被目录覆盖
    expect(models.get('custom-main', 'llm', 'acme-pro')).toMatchObject({
      source: 'user', enabled: true, contextWindow: 1_000,
    });
    expect(synced.every((m) => m.modelId !== 'acme-nolimit')).toBe(true);

    // 删掉手写行再同步：落为 dev 行且默认禁用
    models.delete('custom-main', 'llm', 'acme-pro');
    models.syncDevModels('custom-main', 'llm');
    const devRow = models.get('custom-main', 'llm', 'acme-pro');
    expect(devRow).toMatchObject({
      name: 'Acme Pro', source: 'dev', enabled: false,
      contextWindow: 128_000, maxOutput: 8_000, reasoning: true, toolCall: true,
    });

    // 启用后再同步：enabled 保留，参数以目录为准
    models.setEnabled('custom-main', 'llm', 'acme-pro', true);
    models.syncDevModels('custom-main', 'llm');
    expect(models.get('custom-main', 'llm', 'acme-pro')).toMatchObject({ enabled: true, contextWindow: 128_000 });
  });

  it('删除协议档：删激活档自动切剩余第一档；删到最后一档被拒', () => {
    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'deepseek-copy',
      name: 'DeepSeek Copy',
      authType: 'bearer',
      capability: {
        capability: 'llm', protocol: 'openai-llm', baseUrl: 'https://api.deepseek.com',
      },
    });
    providers.update('deepseek-copy', {
      capability: {
        capability: 'llm', protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic',
      },
    });

    // 双档时删除激活档 openai-llm → 自动切到 anthropic-llm
    providers.update('deepseek-copy', {
      capability: { capability: 'llm', removedProtocols: ['openai-llm'] },
    });
    const capability = providers.get('deepseek-copy').capabilities[0]!;
    expect(capability.activeProtocol).toBe('anthropic-llm');
    expect(capability.protocols).toEqual([
      { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
    ]);

    // 只剩一档时不许删
    expect(() => providers.update('deepseek-copy', {
      capability: { capability: 'llm', removedProtocols: ['anthropic-llm'] },
    })).toThrow(/至少/);
  });

  it('守卫：停用/删除被绑定模型都抛 model_in_use 并带 conflicts', () => {    const store = new MemoryProviderStore();
    const providers = createProviders(store);
    providers.create({
      id: 'custom-main',
      name: 'Custom',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost/v1' },
    });
    const { models, bindings } = createModelStack(store);
    models.save({
      providerId: 'custom-main', capability: 'llm', modelId: 'model-a',
      contextWindow: 32_000, maxOutput: null, toolCall: null,
      reasoning: null, temperature: null, inputImage: null,
    });
    bindings.set({ module: 'memory-llm', providerId: 'custom-main', modelId: 'model-a' });

    const disableError = captureError(() => models.setEnabled('custom-main', 'llm', 'model-a', false));
    expect(disableError).toMatchObject({
      code: 'model_in_use',
      conflicts: [{ module: 'memory-llm', modelId: 'model-a', capability: 'llm' }],
    });
    const deleteError = captureError(() => models.delete('custom-main', 'llm', 'model-a'));
    expect(deleteError).toMatchObject({ code: 'model_in_use' });

    bindings.delete('memory-llm');
    models.setEnabled('custom-main', 'llm', 'model-a', false);
    models.delete('custom-main', 'llm', 'model-a');
    expect(() => models.get('custom-main', 'llm', 'model-a')).toThrow(/不存在/);
  });
});

function captureError(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error('expected to throw');
}
