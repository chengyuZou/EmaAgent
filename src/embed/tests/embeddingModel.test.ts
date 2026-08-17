// 测试 Embedding 公共入口的协议转换、向量校验、归一化和空间身份。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddingModel } from '../embeddingModel.js';
import { createEmbeddingSpace } from '../embeddingSpace.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('EmbeddingModel', () => {
  it('调用 OpenAI 协议并按原输入顺序返回 L2 向量', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 2] },
        { index: 0, embedding: [3, 4] },
      ],
    }), { status: 200 }));
    const model = createEmbeddingModel({
      protocol: 'openai-embed',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1/',
    });

    await expect(model.embed({ model: 'embed-v1', texts: ['one', 'two'] })).resolves.toEqual({
      embeddings: [[0.6, 0.8], [0, 1]],
      dim: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v1/embeddings');
  });

  it('Gemini 用 Header 传递凭据，URL 不泄露 API Key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      embeddings: [{ values: [1, 0] }],
    }), { status: 200 }));
    const model = createEmbeddingModel({
      protocol: 'gemini-embed',
      apiKey: 'secret',
    });

    await model.embed({ model: 'text-embedding-004', texts: ['hello'] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain('secret');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
  });

  it('外部响应数量或维度损坏时显式失败且不重试', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 2] }],
    }), { status: 200 }));
    const model = createEmbeddingModel({ protocol: 'openai-embed' });

    await expect(model.embed({ model: 'embed-v1', texts: ['one', 'two'] }))
      .rejects.toMatchObject({ code: 'embed/invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空批次不访问远端', async () => {
    const model = createEmbeddingModel({ protocol: 'openai-embed' });
    await expect(model.embed({ model: 'embed-v1', texts: [] })).resolves.toEqual({
      embeddings: [],
      dim: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('EmbeddingSpace', () => {
  it('相同事实生成相同 ID，provider/模型/维度任一变化都生成不同 ID', () => {
    const base = {
      providerId: 'provider-a',
      model: 'bge-m3',
      dim: 1024,
    };
    expect(createEmbeddingSpace(base)).toEqual(createEmbeddingSpace(base));
    expect(createEmbeddingSpace(base).id).toMatch(/^[a-f0-9]{64}$/);
    // providerId 承担"同名不同权重"的隔离：不同 provider 的同名模型永不混写
    expect(createEmbeddingSpace({ ...base, providerId: 'provider-b' }).id)
      .not.toBe(createEmbeddingSpace(base).id);
    expect(createEmbeddingSpace({ ...base, model: 'other' }).id)
      .not.toBe(createEmbeddingSpace(base).id);
    expect(createEmbeddingSpace({ ...base, dim: 768 }).id)
      .not.toBe(createEmbeddingSpace(base).id);
  });
});
