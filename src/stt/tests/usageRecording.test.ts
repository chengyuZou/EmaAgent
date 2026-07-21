// 测试 STT 的音频字节数、调用身份和稳定错误码会写入统一用量账本。
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { SttRuntime } from '../sttRuntime.js';
import type { SttAdapter, SttProviderConfig } from '../types.js';

const CONFIG: SttProviderConfig = {
  id: 'stt-provider',
  protocol: 'openai-stt',
  apiKey: 'secret',
  baseUrl: 'https://example.test/v1',
};

describe('SttRuntime 用量记录', () => {
  it('记录成功转录的原始音频字节数', async () => {
    const records: UsageRecord[] = [];
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      async transcribe() { return { text: 'hello' }; },
    };
    const client = new SttRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['stt-provider', adapter]]),
      usageRecorder: { record: (record) => records.push(record) },
    });

    await client.transcribe({
      providerId: 'stt-provider',
      model: 'stt-model',
      audio: new Uint8Array([1, 2, 3]),
      mime: 'audio/wav',
      usageContext: { callId: 'stt-call', sessionId: 'session-1', turnId: 'turn-1' },
    });

    expect(records).toEqual([expect.objectContaining({
      id: 'stt-call',
      capability: 'stt',
      status: 'completed',
      quantity: 3,
      unit: 'byte',
    })]);
  });

  it('把 Provider 异常记录为稳定错误', async () => {
    const records: UsageRecord[] = [];
    const adapter: SttAdapter = {
      protocol: 'openai-stt',
      async transcribe() { throw new Error('network down'); },
    };
    const client = new SttRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['stt-provider', adapter]]),
      usageRecorder: { record: (record) => records.push(record) },
    });

    await expect(client.transcribe({
      providerId: 'stt-provider',
      model: 'stt-model',
      audio: new Uint8Array([1]),
      mime: 'audio/wav',
      usageContext: { callId: 'stt-failed' },
    })).rejects.toMatchObject({ code: 'provider_failed' });

    expect(records).toEqual([expect.objectContaining({
      id: 'stt-failed',
      status: 'failed',
      errorCode: 'stt/provider_failed',
    })]);
  });
});
