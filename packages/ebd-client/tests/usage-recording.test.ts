// 测试 Embedding 与 Rerank 的调用数量、业务身份和失败状态会进入统一用量账本。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '@ema-agent/contracts';
import { EbdRouter } from '../src/router.js';

afterEach(() => vi.unstubAllGlobals());

describe('EbdRouter 用量记录', () => {
  it('记录 Embedding 输入文本数和 Turn 身份', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [3, 4] }, { index: 1, embedding: [0, 1] }],
    }), { status: 200 })));
    const records: UsageRecord[] = [];
    const router = new EbdRouter([{
      id: 'embed-provider',
      protocol: 'openai-embed',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
    }], [], { usageRecorder: { record: (record) => records.push(record) } });

    await router.embed({
      providerId: 'embed-provider',
      model: 'embed-model',
      texts: ['one', 'two'],
      usageContext: { callId: 'embed-call', sessionId: 'session-1', turnId: 'turn-1' },
    });

    expect(records).toEqual([expect.objectContaining({
      id: 'embed-call',
      capability: 'embed',
      status: 'completed',
      sessionId: 'session-1',
      turnId: 'turn-1',
      quantity: 2,
      unit: 'text',
      costUsd: null,
    })]);
  });

  it('记录 Rerank Provider 失败且保留文档数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    const records: UsageRecord[] = [];
    const router = new EbdRouter([], [{
      id: 'rerank-provider',
      protocol: 'cohere-rerank',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
    }], { usageRecorder: { record: (record) => records.push(record) } });

    await expect(router.rerank({
      providerId: 'rerank-provider',
      model: 'rerank-model',
      query: 'query',
      documents: ['one', 'two', 'three'],
      usageContext: { callId: 'rerank-call' },
    })).rejects.toThrow('HTTP 503');

    expect(records).toEqual([expect.objectContaining({
      id: 'rerank-call',
      capability: 'rerank',
      status: 'failed',
      quantity: 3,
      unit: 'document',
      errorCode: 'rerank/provider_failed',
    })]);
  });
});
