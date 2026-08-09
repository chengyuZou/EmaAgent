// 测试 models.dev 只提供带三态能力的模型建议，不承担网络刷新或运行时回退。
import { describe, expect, it } from 'vitest';
import { ModelsDevCatalog } from '../index.js';

describe('ModelsDevCatalog', () => {
  it('按 Provider + Model 隔离同名模型建议', () => {
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

    expect(catalog.get('providerA', 'shared')).toMatchObject({
      contextWindow: 128_000,
      maxOutput: 16_000,
      toolCall: true,
      reasoning: true,
      inputImage: true,
    });
    expect(catalog.get('providerB', 'shared')).toMatchObject({
      contextWindow: 32_000,
      inputImage: false,
    });
  });

  it('源数据没有声明的布尔能力保持未知', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: { models: { modelA: { limit: { context: 8_192 } } } },
    });

    expect(catalog.get('providerA', 'modelA')).toMatchObject({
      toolCall: undefined,
      reasoning: undefined,
      temperature: undefined,
      inputImage: undefined,
    });
  });

  it('非法 payload 不覆盖上一次有效目录', () => {
    const catalog = new ModelsDevCatalog();
    catalog.loadFromJson({
      providerA: {
        models: { modelA: { modalities: { input: ['text'], output: ['text'] } } },
      },
    });
    catalog.loadFromJson(null);

    expect(catalog.listLlmModelIds('providerA')).toEqual(['modelA']);
    expect(catalog.size).toBe(1);
  });
});
