// 测试声音 URI 按角色、Provider 和模型隔离缓存，并避免重复上传参考音频。

import { describe, expect, it, vi } from 'vitest';
import type { CharacterCardId } from '@ema-agent/ids';
import type { TtsAdapter, TtsVoiceRef } from '../types.js';
import {
  ensureVoiceUri,
  TtsVoiceUriCache,
  type TtsVoiceUriStore,
} from '../voiceUri.js';

const CARD_ID = 'card' as CharacterCardId;

describe('TtsVoiceUriCache', () => {
  it('Provider 或模型变化时不会复用其他声音空间的 URI', () => {
    const store = memoryStore();
    const cache = new TtsVoiceUriCache(store);
    cache.set(CARD_ID, 'provider-a', 'model-a', 'voice-a');

    expect(cache.get(CARD_ID, 'provider-a', 'model-a')).toBe('voice-a');
    expect(cache.get(CARD_ID, 'provider-b', 'model-a')).toBeNull();
    expect(cache.get(CARD_ID, 'provider-a', 'model-b')).toBeNull();
  });

  it('缓存命中时直接回填引用，不重复上传参考音频', async () => {
    const store = memoryStore();
    const cache = new TtsVoiceUriCache(store);
    cache.set(CARD_ID, 'provider', 'model', 'cached-voice');
    const uploadVoice = vi.fn(async () => 'uploaded-voice');
    const voice: TtsVoiceRef = {
      refAudioPath: 'voice.wav',
      promptText: '你好',
      promptLang: 'zh',
    };

    await ensureVoiceUri(
      voice,
      adapterWithUpload(uploadVoice),
      'model',
      CARD_ID,
      'provider',
      cache,
    );

    expect(voice.voiceUri).toBe('cached-voice');
    expect(uploadVoice).not.toHaveBeenCalled();
  });
});

function memoryStore(): TtsVoiceUriStore {
  const values = new Map<string, unknown>();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => {
      values.delete(key);
    },
  };
}

function adapterWithUpload(
  uploadVoice: NonNullable<TtsAdapter['uploadVoice']>,
): TtsAdapter {
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
