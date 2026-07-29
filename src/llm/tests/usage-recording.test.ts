// 测试语言模型运行时在完成和失败时都写入调用级用量记录。
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { asLlmCallId } from '../ids.js';
import type { LlmAdapter } from '../adapters/base.js';
import { LanguageModelRuntime } from '../languageModelRuntime.js';
import type { LlmStreamChunk, ProviderConfig } from '../types.js';

const config: ProviderConfig = {
  id: 'provider-1',
  protocol: 'openai-llm',
  apiKey: 'test-key',
};

async function consume(stream: AsyncIterable<LlmStreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // 消费完整流，触发运行时的终态记录。
  }
}

describe('LanguageModelRuntime usage recording', () => {
  it('记录完成调用的真实 Provider 配置 ID 和 Token', async () => {
    const records: UsageRecord[] = [];
    const adapter: LlmAdapter = {
      async *stream() {
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const router = new LanguageModelRuntime(
      [config],
      new Map([['provider-1', adapter]]),
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    await consume(router.stream({
      providerId: 'provider-1',
      model: 'model-1',
      messages: [],
      usageContext: {
        callId: asLlmCallId('llm-call-1'),
        sessionId: 'session-1',
        turnId: 'turn-1',
      },
    }));

    expect(records).toEqual([
      expect.objectContaining({
        id: 'llm-call-1', providerId: 'provider-1', capability: 'llm', status: 'completed',
        inputTokens: 10, outputTokens: 5, costUsd: null, errorCode: null,
      }),
    ]);
  });

  it('记录失败调用，同时继续向调用方抛出 Provider 错误', async () => {
    const records: UsageRecord[] = [];
    const adapter: LlmAdapter = {
      async *stream() {
        yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
        throw Object.assign(new Error('provider down'), { code: 'provider/down' });
      },
    };
    const router = new LanguageModelRuntime(
      [config],
      new Map([['provider-1', adapter]]),
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    await expect(consume(router.stream({
      providerId: 'provider-1',
      model: 'model-1',
      messages: [],
      usageContext: { callId: asLlmCallId('llm-call-failed') },
    }))).rejects.toThrow('provider down');

    expect(records[0]).toMatchObject({
      id: 'llm-call-failed', status: 'failed', inputTokens: null,
      outputTokens: null, errorCode: 'provider/down',
    });
  });

  it('主动取消调用记录为 cancelled，不污染 Provider 失败统计', async () => {
    const records: UsageRecord[] = [];
    const controller = new AbortController();
    const adapter: LlmAdapter = {
      async *stream() {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        throw controller.signal.reason;
      },
    };
    const router = new LanguageModelRuntime(
      [config],
      new Map([['provider-1', adapter]]),
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    await expect(consume(router.stream({
      providerId: 'provider-1',
      model: 'model-1',
      messages: [],
      signal: controller.signal,
      usageContext: { callId: asLlmCallId('llm-call-cancelled') },
    }))).rejects.toMatchObject({ name: 'AbortError' });

    expect(records[0]).toMatchObject({
      id: 'llm-call-cancelled',
      status: 'cancelled',
      errorCode: 'llm/aborted',
    });
  });

  it('消费方提前关闭流时记录为 cancelled', async () => {
    const records: UsageRecord[] = [];
    const adapter: LlmAdapter = {
      async *stream() {
        yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const router = new LanguageModelRuntime(
      [config],
      new Map([['provider-1', adapter]]),
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    for await (const _chunk of router.stream({
      providerId: 'provider-1',
      model: 'model-1',
      messages: [],
      usageContext: { callId: asLlmCallId('llm-call-consumer-closed') },
    })) {
      break;
    }

    expect(records[0]).toMatchObject({
      id: 'llm-call-consumer-closed',
      status: 'cancelled',
      errorCode: 'llm/aborted',
    });
  });

  it('Provider 正常耗尽却缺少 done 时记录为协议失败', async () => {
    const records: UsageRecord[] = [];
    const adapter: LlmAdapter = {
      async *stream() {
        yield { type: 'text_delta', blockIndex: 0, delta: 'partial' };
      },
    };
    const router = new LanguageModelRuntime(
      [config],
      new Map([['provider-1', adapter]]),
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    await expect(consume(router.stream({
      providerId: 'provider-1',
      model: 'model-1',
      messages: [],
      usageContext: { callId: asLlmCallId('llm-call-incomplete') },
    }))).rejects.toThrow('ended without an explicit provider terminal signal');

    expect(records[0]).toMatchObject({
      id: 'llm-call-incomplete',
      status: 'failed',
      errorCode: 'provider/incomplete_stream',
    });
  });
});
