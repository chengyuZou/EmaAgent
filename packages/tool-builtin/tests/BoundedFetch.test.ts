// 这里测试固定搜索服务的 HTTP 响应会在声明长度、实际字节和取消边界处停止读取。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBounded } from '../src/tools/shared/BoundedFetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBounded', () => {
  it('响应声明长度超过预算时不读取正文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('small', {
      headers: { 'content-length': '2000' },
    })));

    await expect(fetchBounded('https://search.example/query', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 100,
    })).rejects.toThrow('超过 100 字节上限');
  });

  it('流式正文实际超过预算时立即取消', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2_000))));

    await expect(fetchBounded('https://search.example/query', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 100,
    })).rejects.toThrow('超过 100 字节上限');
  });

  it('预算内响应返回状态、响应头和完整 Buffer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('搜索结果', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const response = await fetchBounded('https://search.example/query', {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxBytes: 1_000,
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.body.toString('utf8')).toBe('搜索结果');
  });
});
