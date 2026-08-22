// 测试 Rerank 公共入口的协议转换、结果校验、稳定排序和单次调用语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRerankCall } from '../reranker.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('CallRerank', () => {
  it('按分数排序并保留 Provider 原始分数', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { index: 1, relevance_score: 21 },
        { index: 0, relevance_score: 42 },
      ],
    }), { status: 200 }));
    const callRerank = createRerankCall({
      protocol: 'cohere-rerank',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v2/',
    }, 'rerank-v1');

    await expect(callRerank({
      query: 'query',
      documents: ['first', 'second'],
      topK: 2,
    })).resolves.toEqual({
      results: [{ index: 0, score: 42 }, { index: 1, score: 21 }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v2/rerank');
  });

  it('相同分数按原文档下标稳定排序', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0.5 },
        { index: 0, relevance_score: 0.5 },
      ],
    }), { status: 200 }));
    const callRerank = createRerankCall({ protocol: 'cohere-rerank' }, 'rerank-v1');

    await expect(callRerank({
      query: 'query',
      documents: ['a', 'b', 'c'],
      topK: 2,
    })).resolves.toEqual({
      results: [{ index: 0, score: 0.5 }, { index: 2, score: 0.5 }],
    });
  });

  it('外部响应含重复下标时显式失败', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    }), { status: 200 }));
    const callRerank = createRerankCall({ protocol: 'cohere-rerank' }, 'rerank-v1');

    await expect(callRerank({
query: 'query', documents: ['a', 'b'], topK: 2,
    })).rejects.toMatchObject({ code: 'rerank/invalid_response' });
  });

  it('429 原样失败，不在包内补发第二次计费请求', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    const callRerank = createRerankCall({ protocol: 'cohere-rerank' }, 'rerank-v1');

    await expect(callRerank({
query: 'query', documents: ['a'], topK: 1,
    })).rejects.toMatchObject({ code: 'rerank/http_error', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('空文档集不访问远端', async () => {
    const callRerank = createRerankCall({ protocol: 'cohere-rerank' }, 'rerank-v1');
    await expect(callRerank({
query: 'query', documents: [],
    })).resolves.toEqual({ results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
