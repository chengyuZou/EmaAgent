// 测试 Vision 的 Token、图片数、Turn 身份和结构化失败会写入统一用量账本。
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { VisionRuntime } from '../visionRuntime.js';
import type { VisionAdapter } from '../adapters/base.js';
import type { VisionProviderConfig } from '../types.js';

const CONFIG: VisionProviderConfig = {
  id: 'vision-provider',
  protocol: 'openai-vision',
  apiKey: 'secret',
};

describe('VisionRuntime 用量记录', () => {
  it('记录成功提取的 Token 和图片数', async () => {
    const records: UsageRecord[] = [];
    const adapter: VisionAdapter = {
      async extract(request) {
        return {
          providerId: request.providerId,
          model: request.model,
          task: request.task,
          text: 'result',
          blocks: [],
          sources: [],
          usage: { inputTokens: 12, outputTokens: 4 },
        };
      },
    };
    const router = new VisionRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['vision-provider', adapter]]),
      usageRecorder: { record: (record) => records.push(record) },
    });

    await router.extract({
      providerId: 'vision-provider',
      model: 'vision-model',
      inputs: [{ kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/png' }],
      context: { caller: 'turn_attachment', sessionId: 'session-1', turnId: 'turn-1' },
      usageContext: { callId: 'vision-call' },
    });

    expect(records).toEqual([expect.objectContaining({
      id: 'vision-call',
      capability: 'vision',
      status: 'completed',
      inputTokens: 12,
      outputTokens: 4,
      quantity: 1,
      unit: 'image',
      sessionId: 'session-1',
      turnId: 'turn-1',
    })]);
  });

  it('记录分类后的 Provider 失败码', async () => {
    const records: UsageRecord[] = [];
    const adapter: VisionAdapter = {
      async extract() {
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      },
    };
    const router = new VisionRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['vision-provider', adapter]]),
      usageRecorder: { record: (record) => records.push(record) },
    });

    await expect(router.extract({
      providerId: 'vision-provider',
      model: 'vision-model',
      inputs: [{ kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/png' }],
      usageContext: { callId: 'vision-failed' },
    })).rejects.toMatchObject({ code: 'vision/provider_unavailable' });

    expect(records).toEqual([expect.objectContaining({
      id: 'vision-failed',
      status: 'failed',
      errorCode: 'vision/provider_unavailable',
    })]);
  });

  it('并发队列阶段失败时不伪造 Provider 消费', async () => {
    const records: UsageRecord[] = [];
    const adapter: VisionAdapter = {
      async extract() { throw new Error('不应调用'); },
    };
    const router = new VisionRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['vision-provider', adapter]]),
      limiter: {
        async acquire() {
          throw new Error('queue rejected');
        },
      },
      usageRecorder: { record: (record) => records.push(record) },
    });

    await expect(router.extract({
      providerId: 'vision-provider',
      model: 'vision-model',
      inputs: [{ kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })).rejects.toMatchObject({ code: 'vision/provider_failed' });
    expect(records).toEqual([]);
  });
});
