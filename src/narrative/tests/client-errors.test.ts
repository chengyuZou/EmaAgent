// 测试 Narrative Client 的原子请求形状及整体错误分类。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NarrativeClient,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from '../index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NarrativeClient 原子 Recall', () => {
  it('发送 camelCase topK 并解析同代响应', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      generationId: 'generation-1',
      routes: {},
      results: {},
      failures: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new NarrativeClient().recall({
      query: 'query',
      mode: 'hybrid',
      topK: 12,
    })).resolves.toMatchObject({ generationId: 'generation-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      query: 'query',
      mode: 'hybrid',
      topK: 12,
    });
  });

  it('503 表示 Narrative Bridge 整体不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(new NarrativeClient().recall({ query: 'query' }))
      .rejects.toMatchObject({
        name: 'NarrativeUnavailableError',
        code: 'narrative/unavailable',
        retryable: true,
        status: 503,
      });
  });

  it('500 保留为可重试请求错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const request = new NarrativeClient().recall({ query: 'query' });
    await expect(request).rejects.toBeInstanceOf(NarrativeRequestError);
    await expect(request).rejects.not.toBeInstanceOf(NarrativeUnavailableError);
  });

  it('成功状态下的损坏 JSON 不伪装成 Bridge 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    await expect(new NarrativeClient().recall({ query: 'query' }))
      .rejects.toMatchObject({
        code: 'narrative/invalid_response',
        retryable: false,
      });
  });
});
