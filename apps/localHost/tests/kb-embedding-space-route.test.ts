// 测试 LocalHost 原样返回后端 Embedding 空间身份，并把失效操作路由到明确的知识库。
import { describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../src/wiring/index.js';
import { kbRoute } from '../src/routes/knowledge-base.js';
import { modelBindingsRoute } from '../src/routes/model-bindings.js';

const SPACE = {
  id: 'space-provider-a-bge-m3',
  providerId: 'provider-a',
  model: 'bge-m3',
  dim: 1024,
  normalization: 'l2' as const,
  revision: 'provider-managed',
};

describe('KB Embedding 空间路由', () => {
  it('可用模型目录携带 EmbedRuntime 生成的完整空间身份', async () => {
    const embeddingSpace = vi.fn(() => SPACE);
    const app = modelBindingsRoute({
      providerEmbedModels: {
        listAll: () => [{ provider_config_id: 'provider-a', model: 'bge-m3', dim: 1024 }],
      },
      providers: {
        get: () => ({ display_name: 'Provider A' }),
      },
      embed: { embeddingSpace },
    } as unknown as AppBindings);

    const response = await app.request('/available/embed');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: [{
        providerConfigId: 'provider-a',
        providerName: 'Provider A',
        model: 'bge-m3',
        contextWindow: 0,
        dim: 1024,
        embeddingSpace: SPACE,
      }],
    });
    expect(embeddingSpace).toHaveBeenCalledWith('provider-a', 'bge-m3', 1024);
  });

  it('invalidate 使用请求中的 kbId，不会误落到当前 active KB', async () => {
    const invalidateEmbeddings = vi.fn(() => 7);
    const openClient = vi.fn(async () => ({ client: { invalidateEmbeddings } }));
    const openActiveEntry = vi.fn(() => {
      throw new Error('不应解析 active KB');
    });
    const app = kbRoute({
      kb: {
        getKb: (kbId: string) => kbId === 'kb-target' ? { id: kbId } : undefined,
        openClient,
        openActiveEntry,
      },
      providerEmbedModels: { dimFor: () => 1024 },
      embed: { embeddingSpace: () => SPACE },
    } as unknown as AppBindings);

    const response = await app.request('/invalidate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kbId: 'kb-target',
        ebdProviderId: 'provider-a',
        ebdModel: 'bge-m3',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      markedStale: 7,
      embeddingSpace: SPACE,
    });
    expect(openClient).toHaveBeenCalledWith('kb-target');
    expect(openActiveEntry).not.toHaveBeenCalled();
    expect(invalidateEmbeddings).toHaveBeenCalledWith(SPACE.id);
  });
});
