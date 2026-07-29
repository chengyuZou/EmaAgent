// 测试 models.dev 解析、Provider 隔离和手工 Vision 声明的能力解析顺序。
import { describe, expect, it, vi } from 'vitest';
import {
  createModelCapabilityResolver,
  ModelsDevCatalog,
} from '../index.js';

describe('ModelsDevCatalog', () => {
  it('按 Provider + Model 隔离同名模型能力', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: {
          shared: {
            reasoning: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 128_000, output: 16_000 },
          },
        },
      },
      providerB: {
        models: {
          shared: {
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 32_000 },
          },
        },
      },
    });

    const resolver = createModelCapabilityResolver(catalog);
    const providerA = resolver.resolve({
      providerId: 'config-a',
      modelsDevId: 'providerA',
      model: 'shared',
    });
    const providerB = resolver.resolve({
      providerId: 'config-b',
      modelsDevId: 'providerB',
      model: 'shared',
    });

    expect(providerA).toMatchObject({
      input: { image: 'supported' },
      tools: 'supported',
      reasoning: 'supported',
      contextWindow: 128_000,
      maxOutput: 16_000,
      source: 'catalog',
    });
    expect(providerB).toMatchObject({
      input: { image: 'unsupported' },
      tools: 'unsupported',
      reasoning: 'unsupported',
      contextWindow: 32_000,
      source: 'catalog',
    });
  });

  it('Catalog 未收录时只接受当前 Provider 的显式 Vision 声明', () => {
    const catalog = new ModelsDevCatalog();
    const resolver = createModelCapabilityResolver(catalog, {
      supportsManualImageInput: (providerId, model) =>
        providerId === 'vision-config' && model === 'manual-vision',
    });

    expect(resolver.resolve({
      providerId: 'vision-config',
      model: 'manual-vision',
    })).toMatchObject({ input: { image: 'supported' }, source: 'manual' });
    expect(resolver.resolve({
      providerId: 'other-config',
      model: 'manual-vision',
    })).toMatchObject({ input: { image: 'unknown' }, source: 'unknown' });
  });

  it('忽略非法 payload 并保留上一次有效快照', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: {
          modelA: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    });

    catalog.loadFromJson(null);

    expect(catalog.listLlmModelIds('providerA')).toEqual(['modelA']);
    expect(catalog.size).toBe(1);
  });

  it('远端返回空目录时保留已有快照并报告刷新失败', async () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: {
          modelA: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    });
    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({}),
      { status: 200 },
    ));

    await expect(catalog.refresh({ fetchFn })).resolves.toBeNull();
    expect(catalog.listLlmModelIds('providerA')).toEqual(['modelA']);
  });
});
