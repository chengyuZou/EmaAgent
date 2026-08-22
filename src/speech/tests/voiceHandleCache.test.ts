// 测试 SpeechVoiceCache.prepare 的 get-or-register 语义：直通、复用、过期与键隔离。
import { describe, expect, it } from 'vitest';
import type { TtsProviderVoice, TtsVoiceReference } from '@ema-agent/tts';
import { SpeechVoiceCache } from '../voiceHandleCache.js';

const REFERENCE: TtsVoiceReference = {
  kind: 'reference',
  audioPath: 'voice/refs/main.wav',
  promptText: '参考文本',
  promptLanguage: 'zh',
};

const REQUEST = {
  reference: REFERENCE,
  characterId: 'character-1',
  providerId: 'provider-1',
  modelId: 'model-1',
} as const;

function registrarReturning(voice: TtsProviderVoice) {
  let calls = 0;
  return {
    calls: () => calls,
    registrar: async () => {
      calls += 1;
      return voice;
    },
  };
}

describe('SpeechVoiceCache.prepare', () => {
  it('本地参考声音原样直通，不进入缓存', async () => {
    const cache = new SpeechVoiceCache();
    let calls = 0;
    const voice = await cache.prepare({
      ...REQUEST,
      ttsVoiceRegistrar: async reference => {
        calls += 1;
        return reference;
      },
    });
    expect(voice).toEqual(REFERENCE);
    expect(calls).toBe(1);
    expect(cache.get('character-1', 'provider-1', 'model-1')).toBeNull();
  });

  it('云端声音命中缓存后不再重复注册', async () => {
    const cache = new SpeechVoiceCache();
    const source = registrarReturning({ kind: 'provider', id: 'voice-1', lifetime: 'ephemeral' });
    const registrar = source.registrar;

    const first = await cache.prepare({ ...REQUEST, ttsVoiceRegistrar: registrar });
    const second = await cache.prepare({ ...REQUEST, ttsVoiceRegistrar: registrar });

    expect(first).toMatchObject({ kind: 'provider', id: 'voice-1' });
    expect(second).toMatchObject({ kind: 'provider', id: 'voice-1' });
    expect(source.calls()).toBe(1);
  });

  it('过期声音重新注册', async () => {
    let now = 1_000;
    const cache = new SpeechVoiceCache({ ephemeralTtlMs: 100, now: () => now });
    const source = registrarReturning({ kind: 'provider', id: 'voice-1', lifetime: 'ephemeral' });

    await cache.prepare({ ...REQUEST, ttsVoiceRegistrar: source.registrar });
    now += 200;
    await cache.prepare({ ...REQUEST, ttsVoiceRegistrar: source.registrar });

    expect(source.calls()).toBe(2);
  });

  it('换模型使用独立缓存键，必须重新注册', async () => {
    const cache = new SpeechVoiceCache();
    const source = registrarReturning({ kind: 'provider', id: 'voice-1', lifetime: 'ephemeral' });

    await cache.prepare({ ...REQUEST, ttsVoiceRegistrar: source.registrar });
    await cache.prepare({ ...REQUEST, modelId: 'model-2', ttsVoiceRegistrar: source.registrar });

    expect(source.calls()).toBe(2);
  });
});
