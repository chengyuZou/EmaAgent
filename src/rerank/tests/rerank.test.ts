// 测试 Rerank 协议映射、响应校验、Top-K 边界和 Usage 失败记录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { CohereRerankAdapter } from '../adapters/cohere.js';
import { RerankRuntime } from '../runtime.js';
import type { RerankProviderConfig } from '../types.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const config: RerankProviderConfig = {
  id: 'rerank-provider', protocol: 'cohere-rerank', apiKey: 'secret',
  baseUrl: 'https://api.example.test/v1///',
};

describe('RerankRuntime', () => {
  it('调用绝对 rerank 地址并将 Top-K 裁剪到文档数', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config]);

    const result = await runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a', 'b'], topK: 20,
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('https://api.example.test/v1/rerank');
    expect(JSON.parse(init?.body as string).top_n).toBe(2);
    expect(result.results).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
  });

  it('Provider 失败时记录文档数和失败状态', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const records: UsageRecord[] = [];
    const runtime = new RerankRuntime([config], {
      usageRecorder: { record: (record) => records.push(record) },
    });

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['one', 'two', 'three'], usageContext: { callId: 'call-1' },
    })).rejects.toThrow('HTTP 503');
    expect(records).toEqual([expect.objectContaining({
      id: 'call-1', capability: 'rerank', status: 'failed', quantity: 3, unit: 'document',
    })]);
  });

  it('缺失 baseUrl 时拒绝调用', async () => {
    const adapter = new CohereRerankAdapter({ ...config, baseUrl: undefined });
    await expect(adapter.rerank('query', ['doc'], 1, 'model')).rejects.toThrow('rerank/base_url_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
