// 测试 Provider 声音句柄按身份隔离、按 TTL 失效，并避免有效期内重复上传。

import { describe, expect, it, vi } from 'vitest';
import type { CharacterCardId } from '@ema-agent/ids';
import type { TtsAdapter, TtsVoiceRef } from '../types.js';
import {
  ensureProviderVoiceHandle,
  TtsVoiceHandleCache,
} from '../voiceHandle.js';

const CARD_ID = 'card' as CharacterCardId;

describe('TtsVoiceHandleCache', () => {
  it('Provider 或模型变化时不会复用其他声音空间的句柄', () => {
    const cache = new TtsVoiceHandleCache();
    cache.set(CARD_ID, 'provider-a', 'model-a', {
      value: 'voice-a',
      lifetime: 'durable',
    });

    expect(cache.get(CARD_ID, 'provider-a', 'model-a')).toEqual({
      value: 'voice-a',
      lifetime: 'durable',
    });
    expect(cache.get(CARD_ID, 'provider-b', 'model-a')).toBeNull();
    expect(cache.get(CARD_ID, 'provider-a', 'model-b')).toBeNull();
  });

  it('缓存命中时直接回填引用，不重复上传参考音频', async () => {
    const cache = new TtsVoiceHandleCache();
    cache.set(CARD_ID, 'provider', 'model', {
      value: 'cached-voice',
      lifetime: 'durable',
    });
    const uploadVoice = vi.fn(async () => ({
      value: 'uploaded-voice',
      lifetime: 'ephemeral' as const,
    }));
    const voice: TtsVoiceRef = {
      refAudioPath: 'voice.wav',
      promptText: '你好',
      promptLang: 'zh',
    };

    const resolved = await ensureProviderVoiceHandle(
      voice,
      adapterWithUpload(uploadVoice),
      'model',
      CARD_ID,
      'provider',
      cache,
    );

    expect(resolved.providerVoice).toEqual({
      value: 'cached-voice',
      lifetime: 'durable',
    });
    expect(uploadVoice).not.toHaveBeenCalled();
  });

  it('临时句柄超过 TTL 后重新上传，不会长期复用陈旧值', async () => {
    let now = 1_000;
    const cache = new TtsVoiceHandleCache({
      ephemeralTtlMs: 100,
      now: () => now,
    });
    const uploadVoice = vi.fn(async () => ({
      value: `uploaded-${uploadVoice.mock.calls.length}`,
      lifetime: 'ephemeral' as const,
    }));
    const voice: TtsVoiceRef = {
      refAudioPath: 'voice.wav',
      promptText: '你好',
      promptLang: 'zh',
    };

    const first = await ensureProviderVoiceHandle(
      voice,
      adapterWithUpload(uploadVoice),
      'model',
      CARD_ID,
      'provider',
      cache,
    );
    expect(first.providerVoice?.value).toBe('uploaded-1');

    now += 101;
    const second = await ensureProviderVoiceHandle(
      voice,
      adapterWithUpload(uploadVoice),
      'model',
      CARD_ID,
      'provider',
      cache,
    );

    expect(second.providerVoice?.value).toBe('uploaded-2');
    expect(uploadVoice).toHaveBeenCalledTimes(2);
  });
});

function adapterWithUpload(uploadVoice: NonNullable<TtsAdapter['uploadVoice']>): TtsAdapter {
  return {
    protocol: 'openai-tts',
    capabilitiesFor: () => ({
      audioDelivery: 'http_chunks',
      supportsAbort: true,
    }),
    async *stream() {
      yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
    },
    uploadVoice,
  };
}
