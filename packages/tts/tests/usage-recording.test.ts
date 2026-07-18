// 测试 TTS 以清洗后字符数计量，并区分流式成功、Provider 错误和不完整终态。
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '@ema-agent/contracts';
import { TtsClient } from '../src/service.js';
import type { TtsAdapter, TtsProviderConfig, TtsRequest, TtsVoiceRef } from '../src/types.js';

const CONFIG: TtsProviderConfig = {
  id: 'tts-provider',
  protocol: 'openai-tts',
  apiKey: 'secret',
  baseUrl: 'https://example.test/v1',
};
const VOICE: TtsVoiceRef = {
  refAudioPath: '/voice.wav',
  promptText: 'prompt',
  promptLang: 'zh',
  voiceUri: 'voice-id',
};

function request(callId: string): TtsRequest {
  return {
    providerId: 'tts-provider',
    model: 'tts-model',
    text: '你好',
    voice: VOICE,
    usageContext: { callId, sessionId: 'session-1', turnId: 'turn-1' },
  };
}

describe('TtsClient 用量记录', () => {
  it('流正常完成后记录清洗后的字符数', async () => {
    const records: UsageRecord[] = [];
    const adapter: TtsAdapter = {
      protocol: 'openai-tts',
      capabilitiesFor: () => ({ audioDelivery: 'http_chunks', supportsAbort: true }),
      async *stream() {
        yield { type: 'done' as const, totalBytes: 0, firstByteMs: 1 };
      },
    };
    const client = new TtsClient(
      [CONFIG],
      new Map([['tts-provider', adapter]]),
      {},
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    for await (const _event of client.synthesize(request('tts-call'))) { /* 消费完整流 */ }

    expect(records).toEqual([expect.objectContaining({
      id: 'tts-call',
      capability: 'tts',
      status: 'completed',
      quantity: 2,
      unit: 'character',
      errorCode: null,
    })]);
  });

  it('把 Adapter 错误事件记录为失败', async () => {
    const records: UsageRecord[] = [];
    const adapter: TtsAdapter = {
      protocol: 'openai-tts',
      capabilitiesFor: () => ({ audioDelivery: 'http_chunks', supportsAbort: true }),
      async *stream() {
        yield { type: 'error' as const, code: 'transient_network' as const, message: 'down' };
      },
    };
    const client = new TtsClient(
      [CONFIG],
      new Map([['tts-provider', adapter]]),
      {},
      { usageRecorder: { record: (record) => records.push(record) } },
    );

    for await (const _event of client.synthesize(request('tts-failed'))) { /* 消费完整流 */ }

    expect(records).toEqual([expect.objectContaining({
      id: 'tts-failed',
      status: 'failed',
      errorCode: 'tts/transient_network',
    })]);
  });
});
