// 测试 Rerank 协议映射、响应校验、Top-K 边界和 Usage 失败记录。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord, UsageRecorder } from '@ema-agent/usage';
import { CohereRerankAdapter } from '../adapters/cohere.js';
import { RerankError } from '../errors.js';
import { RerankRuntime } from '../runtime.js';
import type { RerankProviderConfig } from '../types.js';

const noopRecorder: UsageRecorder = { record: () => undefined };

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
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

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
    // 每次调用生成新 Response:body 只能消费一次,重试会打第二发。
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('unavailable', { status: 503 })));
    const records: UsageRecord[] = [];
    const runtime = new RerankRuntime([config], {
      usageRecorder: { record: (record) => records.push(record) },
    });

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['one', 'two', 'three'], usageContext: { callId: 'call-1' },
    })).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(records).toEqual([expect.objectContaining({
      id: 'call-1', capability: 'rerank', status: 'failed', quantity: 3, unit: 'document',
    })]);
  });

  it('缺失 baseUrl 时拒绝调用', async () => {
    const adapter = new CohereRerankAdapter({ ...config, baseUrl: undefined });
    await expect(adapter.rerank('query', ['doc'], 1, 'model')).rejects.toThrow('rerank/base_url_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('越界分数按本批 min-max 归一到 [0,1]', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [
        { index: 0, relevance_score: 42 },
        { index: 1, relevance_score: 21 },
        { index: 2, relevance_score: 0 },
      ],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const result = await runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a', 'b', 'c'], topK: 3,
    });

    expect(result.results).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 0.5 },
      { index: 2, score: 0 },
    ]);
  });

  it('分数全部在 [0,1] 时原样返回以保留阈值语义', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.35 }, { index: 1, relevance_score: 0.1 }],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const result = await runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a', 'b'], topK: 2,
    });

    expect(result.results).toEqual([
      { index: 0, score: 0.35 },
      { index: 1, score: 0.1 },
    ]);
  });

  it('分数全部相同且越界时统一映射为 1，不误触发低分过滤', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 7 }, { index: 1, relevance_score: 7 }],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const result = await runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a', 'b'], topK: 2,
    });

    expect(result.results).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 1 },
    ]);
  });
});

describe('RerankRuntime 有限重试', () => {
  const okPayload = () => new Response(JSON.stringify({
    results: [{ index: 0, relevance_score: 0.5 }],
  }), { status: 200 });

  function call(runtime: RerankRuntime, signal?: AbortSignal) {
    return runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a'], topK: 1, signal,
    });
  }

  it('429 退避后补枪成功', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockImplementationOnce(() => Promise.resolve(okPayload()));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const result = await call(runtime);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([{ index: 0, score: 0.5 }]);
  });

  it('网络层错误（无 HTTP 状态）补枪成功', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(() => Promise.resolve(okPayload()));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const result = await call(runtime);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(1);
  });

  it('401 属配置故障，不重试', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    await expect(call(runtime)).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('响应校验失败不重试（脏数据不是瞬时故障）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ index: 9, relevance_score: 0.5 }],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    await expect(call(runtime)).rejects.toThrow('rerank/invalid_index');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('退避期间取消立即抛出，不等退避完成', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    const controller = new AbortController();
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    const pending = call(runtime, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const startedAt = Date.now();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('RerankRuntime 错误码', () => {
  it('缺失分数时显式失败，而不是静默置 0', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{ index: 0 }],
    }), { status: 200 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a'], topK: 1,
    })).rejects.toThrow('rerank/missing_score');
  });

  it('非法 topK 抛出带稳定错误码的 RerankError', async () => {
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a'], topK: 0,
    })).rejects.toMatchObject({ code: 'rerank/invalid_top_k' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('超时错误写入 usage 的 errorCode 为 rerank/timeout', async () => {
    const records: UsageRecord[] = [];
    const runtime = new RerankRuntime(
      [config],
      { usageRecorder: { record: (record) => records.push(record) } },
      () => ({
        rerank: async (): Promise<never> => {
          throw new DOMException('timed out', 'TimeoutError');
        },
      }),
    );

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a'], topK: 1,
    })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(records[0]).toMatchObject({
      capability: 'rerank',
      status: 'failed',
      errorCode: 'rerank/timeout',
    });
  });

  it('HTTP 错误保留 status 并携带统一错误码', async () => {
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    const runtime = new RerankRuntime([config], { usageRecorder: noopRecorder });

    await expect(runtime.rerank({
      providerId: config.id, model: 'rerank-model', query: 'query',
      documents: ['a'], topK: 1,
    })).rejects.toMatchObject({
      code: 'rerank/http_error',
      status: 401,
    });
    expect(RerankError).toBeTypeOf('function');
  });
});
