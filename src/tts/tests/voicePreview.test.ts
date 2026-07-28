// 测试角色声音试听沿正式 TTS 运行时合成音频，并对缺失运行时给出明确失败。

import { describe, expect, it } from 'vitest';
import type { CharacterCardId } from '@ema-agent/ids';
import type { TtsAdapter, TtsStreamEvent, TtsVoiceRef } from '../types.js';
import {
  TtsVoicePreview,
  TtsVoicePreviewError,
  type TtsVoicePreviewSource,
} from '../voicePreview.js';
import type { TtsVoiceUriStore } from '../voiceUri.js';

const CARD_ID = 'card' as CharacterCardId;

describe('TtsVoicePreview', () => {
  it('运行时不存在对应 Provider 时明确失败', async () => {
    const preview = new TtsVoicePreview(
      {
        getAdapter: () => undefined,
        synthesize: () => emptyStream(),
      },
      voiceSource(),
      memoryStore(),
    );

    await expect(
      preview.synthesize('missing-provider', 'model', '你好'),
    ).rejects.toMatchObject<TtsVoicePreviewError>({
      code: 'adapter_unavailable',
    });
  });

  it('拼接正式运行时产出的音频块并保留实际 MIME', async () => {
    const adapter = gptSoVitsAdapter();
    const preview = new TtsVoicePreview(
      {
        getAdapter: () => adapter,
        synthesize: () => audioStream(),
      },
      voiceSource(),
      memoryStore(),
    );

    const result = await preview.synthesize('provider', 'model', '你好');

    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mime).toBe('audio/wav');
  });
});

function voiceSource(): TtsVoicePreviewSource {
  const voice: TtsVoiceRef = {
    refAudioPath: 'voice.wav',
    promptText: '你好',
    promptLang: 'zh',
  };
  return {
    current: () => ({ cardId: CARD_ID, voice }),
  };
}

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

function gptSoVitsAdapter(): TtsAdapter {
  return {
    protocol: 'gpt-sovits-tts',
    capabilitiesFor: () => ({
      audioDelivery: 'http_chunks',
      supportsAbort: true,
    }),
    stream: audioStream,
  };
}

async function* audioStream(): AsyncIterable<TtsStreamEvent> {
  yield {
    type: 'audio_chunk',
    bytes: Uint8Array.from([1, 2]),
    mime: 'audio/wav',
  };
  yield {
    type: 'audio_chunk',
    bytes: Uint8Array.from([3]),
    mime: 'audio/wav',
  };
  yield { type: 'done', totalBytes: 3, firstByteMs: 1 };
}

async function* emptyStream(): AsyncIterable<TtsStreamEvent> {
  yield { type: 'done', totalBytes: 0, firstByteMs: 0 };
}
