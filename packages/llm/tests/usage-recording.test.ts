// 测试 LLM Router 在完成和失败时都写入调用级用量记录。
import { describe, expect, it } from 'vitest';
import { asLlmCallId, type UsageRecord } from '@ema-agent/contracts';
import type { LlmAdapter } from '../src/adapters/base.js';
import { LlmRouter } from '../src/router.js';
import type { LlmStreamChunk, ProviderConfig } from '../src/types.js';

const config: ProviderConfig = {
  id: 'provider-1',
  protocol: 'openai-llm',
  apiKey: 'test-key',
};

async function consume(stream: AsyncIterable<LlmStreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // 消费完整流，触发 Router 的终态记录。
  }
}

describe('LlmRouter usage recording', () => {
  it('记录完成调用的真实 Provider 配置 ID 和 Token', async () => {
    const records: UsageRecord[] = [];
    const adapter: LlmAdapter = {
      async *stream() {
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const router = new LlmRouter(
      [config],
      new Map([['provider-1', adapter]]),
      undefined,
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
    const router = new LlmRouter(
      [config],
      new Map([['provider-1', adapter]]),
      undefined,
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
});
