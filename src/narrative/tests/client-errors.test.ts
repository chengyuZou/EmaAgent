// 测试 Narrative Client 的原子请求形状、configure/shutdown 语义及整体错误分类。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NarrativeClient,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from '../index.js';

const LLM = { baseUrl: 'http://llm.test/v1', modelId: 'test-model' };

function createClient(): NarrativeClient {
  return new NarrativeClient({ baseUrl: 'http://bridge.test/', secret: 'test-secret' });
}

function lastRequest(): { url: string; init: RequestInit } {
  const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  return { url: String(call?.[0]), init: call?.[1] as RequestInit };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NarrativeClient 原子 Recall', () => {
  it('发送携带 LLM 连接的 camelCase 请求并解析响应', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      routes: {},
      results: {},
      failures: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createClient().recall({
      query: 'query',
      llm: LLM,
      mode: 'hybrid',
      topK: 12,
    })).resolves.toEqual({ routes: {}, results: {}, failures: [] });

    const { url, init } = lastRequest();
    expect(url).toBe('http://bridge.test/narrative/recall');
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'query',
      llm: LLM,
      mode: 'hybrid',
      topK: 12,
    });
    expect((init.headers as Record<string, string>)['X-Ema-Secret']).toBe('test-secret');
  });

  it('503 表示 Narrative Bridge 整体不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(createClient().recall({ query: 'query', llm: LLM }))
      .rejects.toMatchObject({
        name: 'NarrativeUnavailableError',
        code: 'narrative/unavailable',
        status: 503,
      });
  });

  it('500 保留为请求错误而不伪装成 Bridge 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const request = createClient().recall({ query: 'query', llm: LLM });
    await expect(request).rejects.toBeInstanceOf(NarrativeRequestError);
    await expect(request).rejects.not.toBeInstanceOf(NarrativeUnavailableError);
  });

  it('成功状态下的损坏 JSON 不伪装成 Bridge 不可用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    await expect(createClient().recall({ query: 'query', llm: LLM }))
      .rejects.toMatchObject({
        code: 'narrative/invalid_response',
      });
  });
});

describe('NarrativeClient 进程管理', () => {
  it('configure 送达 Embedding 连接；409 等同已配置', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'configured' }));
    vi.stubGlobal('fetch', fetchMock);

    const embed = { baseUrl: 'http://embed.test/v1', modelId: 'embed-model', dim: 1024 };
    await expect(createClient().configure({ embed })).resolves.toBe(true);
    const { url, init } = lastRequest();
    expect(url).toBe('http://bridge.test/internal/configure');
    expect(JSON.parse(String(init.body))).toEqual({ embed });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })));
    await expect(createClient().configure({ embed })).resolves.toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('conn refused'); }));
    await expect(createClient().configure({ embed })).resolves.toBe(false);
  });

  it('shutdown 只在 Bridge 应答时视为生效', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'shutting_down' })));
    await expect(createClient().shutdown()).resolves.toBe(true);
    expect(lastRequest().url).toBe('http://bridge.test/internal/shutdown');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('conn refused'); }));
    await expect(createClient().shutdown()).resolves.toBe(false);
  });
});
