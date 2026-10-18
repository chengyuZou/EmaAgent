import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@ema-agent/storage';
import {
  ModelBindings,
  ModelsDevCatalog,
  ProviderModels,
  Providers,
} from '../index.js';

const databases: Database[] = [];

class TestProfileDatabase extends Database {
  constructor() {
    super({ memory: true, kind: 'profile' });
    this.migrate();
    databases.push(this);
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createProviders(database: TestProfileDatabase) {
  return new Providers(database);
}

// 一个条目参数齐全, 另一个缺少同步到数据库时必需的 contextWindow.
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

function createModelStack(database: TestProfileDatabase) {
  const providers = new Providers(database);
  const models = new ProviderModels(database, providers, createTestCatalog());
  return {
    models,
    bindings: new ModelBindings(database, models),
  };
}

describe('Provider 控制面', () => {
  it('自建 Provider 创建后按能力解析连接，key 来自 Provider 的一把 key', () => {
    const store = new TestProfileDatabase();
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

  it('重复 id 判定按 (id, capability)：同能力拒绝，无此能力则追加能力档', () => {
    const store = new TestProfileDatabase();
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

    expect(() => providers.create({
      id: 'my-gateway',
      name: 'My Gateway',
      authType: 'bearer',
      capability: {
        capability: 'llm',
        protocol: 'openai-llm',
        baseUrl: 'https://gateway.example/v1',
      },
    })).toThrow(/已存在/);

    providers.create({
      id: 'my-gateway',
      name: 'My Gateway',
      authType: 'bearer',
      capability: {
        capability: 'vision',
        protocol: 'openai-llm',
        baseUrl: 'https://gateway.example/v1',
      },
    });
    const provider = providers.get('my-gateway');
    expect(provider.capabilities.map((c) => c.capability).sort()).toEqual(['llm', 'vision']);
    expect(providers.resolveConnection('my-gateway', 'vision').apiKey).toBe('sk-gateway');
  });

  it('id 是语义 slug：用户显式给定；非法/空值创建被拒', () => {
    const store = new TestProfileDatabase();
    const providers = createProviders(store);

    const created = providers.create({
      id: 'company-gateway',
      name: 'Company Gateway',
      authType: 'none',
      capability: { capability: 'llm', protocol: 'openai-llm', baseUrl: 'http://localhost:8000/v1' },
    });

    expect(created.id).toBe('company-gateway');
    expect(created.capabilities).toMatchObject([{
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
    const store = new TestProfileDatabase();
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
    providers.update('siliconflow-copy', {
      capability: { capability: 'tts', protocol: 'siliconflow-tts', baseUrl: 'https://api.siliconflow.cn/v1' },
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
    const store = new TestProfileDatabase();
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
    const store = new TestProfileDatabase();
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
      .toThrow(/不存在/);

    // 先解除现有绑定才能停用, 随后不能再绑定已停用的模型.
    bindings.delete('memory-llm');
    models.setEnabled('custom-main', 'llm', 'model-a', false);
    expect(() => bindings.set({ module: 'memory-llm', providerId: 'custom-main', modelId: 'model-a' }))
      .toThrow(/已启用/);
  });

  it('手填：新增 user 行默认启用；dev 行禁修改', () => {
    const store = new TestProfileDatabase();
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
    const store = new TestProfileDatabase();
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

    models.syncDevModels('custom-main', 'llm');
    const synced = models.listByProvider('custom-main', 'llm');
    // 同 ID 的手填模型保留用户参数, 不由目录覆盖.
    expect(models.get('custom-main', 'llm', 'acme-pro')).toMatchObject({
      source: 'user', enabled: true, contextWindow: 1_000,
    });
    expect(synced.every((m) => m.modelId !== 'acme-nolimit')).toBe(true);

    // 删除手填记录后再同步, 才会创建默认禁用的目录模型.
    models.delete('custom-main', 'llm', 'acme-pro');
    models.syncDevModels('custom-main', 'llm');
    const devRow = models.get('custom-main', 'llm', 'acme-pro');
    expect(devRow).toMatchObject({
      name: 'Acme Pro', source: 'dev', enabled: false,
      contextWindow: 128_000, maxOutput: 8_000, reasoning: true, toolCall: true,
    });

    // 再次同步更新目录参数, 不改变用户选定的启用状态.
    models.setEnabled('custom-main', 'llm', 'acme-pro', true);
    models.syncDevModels('custom-main', 'llm');
    expect(models.get('custom-main', 'llm', 'acme-pro')).toMatchObject({ enabled: true, contextWindow: 128_000 });
  });

  it('删除协议档：删激活档自动切剩余第一档；删到最后一档被拒', () => {
    const store = new TestProfileDatabase();
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

    providers.update('deepseek-copy', {
      capability: { capability: 'llm', removedProtocols: ['openai-llm'] },
    });
    const capability = providers.get('deepseek-copy').capabilities[0]!;
    expect(capability.activeProtocol).toBe('anthropic-llm');
    expect(capability.protocols).toEqual([
      { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
    ]);

    expect(() => providers.update('deepseek-copy', {
      capability: { capability: 'llm', removedProtocols: ['anthropic-llm'] },
    })).toThrow(/至少/);
  });

  it('守卫：停用/删除被绑定模型都抛 model_in_use 并带 conflicts', () => {
    const store = new TestProfileDatabase();
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
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected to throw');
}
