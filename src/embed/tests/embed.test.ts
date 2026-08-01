// 测试 Embedding 空间身份、协议映射、向量归一化和 Usage 记录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { GeminiEmbedAdapter } from '../adapters/gemini.js';
import { createEmbeddingSpace } from '../embeddingSpace.js';
import { EmbedRuntime } from '../runtime.js';
import type { EmbedProviderConfig } from '../types.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('Embedding 空间身份', () => {
  it('相同输入生成相同 ID，模型或维度变化会生成不同 ID', () => {
    const base = { providerId: 'provider-a', model: 'bge-m3', dim: 1024, revision: 'v1' };
    expect(createEmbeddingSpace(base)).toEqual(createEmbeddingSpace(base));
    expect(createEmbeddingSpace(base).id).toMatch(/^[a-f0-9]{64}$/);
    expect(createEmbeddingSpace({ ...base, model: 'other' }).id).not.toBe(createEmbeddingSpace(base).id);
    expect(createEmbeddingSpace({ ...base, dim: 768 }).id).not.toBe(createEmbeddingSpace(base).id);
  });
});

describe('EmbedRuntime', () => {
  it('归一化向量、返回完整空间身份并记录调用数量', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [3, 4] }, { index: 1, embedding: [0, 2] }],
    }), { status: 200 }));
    const records: UsageRecord[] = [];
    const runtime = new EmbedRuntime([{
      id: 'provider-a',
      protocol: 'openai-embed',
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      embeddingRevision: '2026-07',
    }], { usageRecorder: { record: (record) => records.push(record) } });

    const result = await runtime.embed({
      providerId: 'provider-a',
      model: 'embed-v1',
      texts: ['one', 'two'],
      usageContext: { callId: 'call-1', sessionId: 'session-1', turnId: 'turn-1' },
    });

    expect(result.embeddings).toEqual([[0.6, 0.8], [0, 1]]);
    expect(result.space).toMatchObject({
      providerId: 'provider-a', model: 'embed-v1', dim: 2,
      normalization: 'l2', revision: '2026-07',
    });
    expect(runtime.embeddingSpace('provider-a', 'embed-v1', 2).id).toBe(result.space.id);
    expect(records).toEqual([expect.objectContaining({
      id: 'call-1', capability: 'embed', status: 'completed', quantity: 2, unit: 'text',
    })]);
  });

  it('Gemini 使用请求头传递密钥，不把密钥拼入 URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    const config: EmbedProviderConfig = {
      id: 'gemini', protocol: 'gemini-embed', apiKey: 'secret',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    };
    const adapter = new GeminiEmbedAdapter(config);

    await adapter.embed(['hello'], 'text-embedding-004');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).not.toContain('key=');
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
  });
});

describe('EmbedRuntime 有限重试', () => {
  const provider: EmbedProviderConfig = {
    id: 'provider-a', protocol: 'openai-embed', apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
  };
  const okPayload = () => new Response(JSON.stringify({
    data: [{ index: 0, embedding: [1, 0] }],
  }), { status: 200 });

  it('5xx 退避后补枪成功', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockImplementationOnce(() => Promise.resolve(okPayload()));
    const runtime = new EmbedRuntime([provider]);

    const result = await runtime.embed({ providerId: 'provider-a', model: 'm', texts: ['x'] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toEqual([[1, 0]]);
  });

  it('网络层错误（无 HTTP 状态）补枪成功', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(() => Promise.resolve(okPayload()));
    const runtime = new EmbedRuntime([provider]);

    await runtime.embed({ providerId: 'provider-a', model: 'm', texts: ['x'] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('401 属配置故障，不重试', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    const runtime = new EmbedRuntime([provider]);

    await expect(
      runtime.embed({ providerId: 'provider-a', model: 'm', texts: ['x'] }),
    ).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
