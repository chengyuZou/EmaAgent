// 使用当前角色声音沿正式 TTS 管线生成短试听，返回可直接播放的有界音频。
import type { CharacterCardId } from '@ema-agent/ids';
import type { TtsRuntime } from './ttsRuntime.js';
import type { TtsVoiceRef } from './types.js';
import {
  ensureProviderVoiceHandle,
  TtsVoiceHandleCache,
} from './voiceHandle.js';

export type TtsVoicePreviewErrorCode =
  | 'adapter_unavailable'
  | 'no_reference_audio'
  | 'voice_upload_failed'
  | 'no_audio'
  | 'synthesis_failed';

export class TtsVoicePreviewError extends Error {
  constructor(
    readonly code: TtsVoicePreviewErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TtsVoicePreviewError';
  }
}

export interface TtsVoicePreviewSource {
  current(): {
    cardId: CharacterCardId;
    voice: TtsVoiceRef;
  } | null;
}

export interface TtsVoicePreviewResult {
  bytes: Uint8Array;
  mime: string;
}

export class TtsVoicePreview {
  constructor(
    private readonly runtime: Pick<TtsRuntime, 'getAdapter' | 'synthesize'>,
    private readonly voices: TtsVoicePreviewSource,
    private readonly voiceHandles: TtsVoiceHandleCache,
  ) {}

  async synthesize(
    providerId: string,
    model: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<TtsVoicePreviewResult> {
    const adapter = this.runtime.getAdapter(providerId);
    if (!adapter) {
      throw new TtsVoicePreviewError(
        'adapter_unavailable',
        'TTS Provider 运行时不可用',
      );
    }

    const current = this.voices.current();
    if (!current) {
      throw new TtsVoicePreviewError(
        'no_reference_audio',
        '当前角色卡未配置参考音频，无法测试声音克隆',
      );
    }

    try {
      const voice = await ensureProviderVoiceHandle(
        current.voice,
        adapter,
        model,
        current.cardId,
        providerId,
        this.voiceHandles,
        signal,
      );
      if (!voice.providerVoice && adapter.protocol !== 'gpt-sovits-tts') {
        throw new TtsVoicePreviewError(
          'voice_upload_failed',
          '参考音频上传失败',
        );
      }

      const chunks: Uint8Array[] = [];
      let mime = 'audio/mpeg';
      for await (const event of this.runtime.synthesize({
        providerId,
        model,
        text,
        voice,
        format: 'mp3',
        abortSignal: signal,
      })) {
        if (event.type !== 'audio_chunk') continue;
        chunks.push(event.bytes);
        mime = event.mime;
      }
      if (chunks.length === 0) {
        throw new TtsVoicePreviewError('no_audio', '合成未产生音频');
      }
      return { bytes: concatChunks(chunks), mime };
    } catch (error) {
      if (error instanceof TtsVoicePreviewError) throw error;
      throw new TtsVoicePreviewError(
        'synthesis_failed',
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
