// 使用当前角色参考声音沿正式协议入口生成一段有界试听音频。
import type { TextToSpeech, TtsVoiceReference } from '@ema-agent/tts';
import { prepareSpeechVoice, SpeechVoiceCache } from './voiceHandleCache.js';

export type SpeechVoicePreviewErrorCode =
  | 'client_unavailable'
  | 'no_reference_audio'
  | 'no_audio'
  | 'synthesis_failed';

export class SpeechVoicePreviewError extends Error {
  constructor(
    readonly code: SpeechVoicePreviewErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpeechVoicePreviewError';
  }
}

export interface SpeechVoicePreviewSource {
  current(): { readonly cardId: string; readonly voice: TtsVoiceReference } | null;
}

export interface SpeechVoicePreviewResult {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

export class SpeechVoicePreview {
  constructor(
    private readonly resolveTextToSpeech: (providerConfigId: string) => TextToSpeech | undefined,
    private readonly voices: SpeechVoicePreviewSource,
    private readonly voiceCache: SpeechVoiceCache,
  ) {}

  async synthesize(
    providerConfigId: string,
    model: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<SpeechVoicePreviewResult> {
    const textToSpeech = this.resolveTextToSpeech(providerConfigId);
    if (!textToSpeech) {
      throw new SpeechVoicePreviewError('client_unavailable', 'TTS Provider 运行时不可用');
    }
    const current = this.voices.current();
    if (!current) {
      throw new SpeechVoicePreviewError('no_reference_audio', '当前角色未配置参考音频');
    }

    try {
      const voice = await prepareSpeechVoice(
        current.voice,
        textToSpeech,
        model,
        current.cardId,
        providerConfigId,
        this.voiceCache,
        signal,
      );
      const chunks: Uint8Array[] = [];
      let mime = 'audio/mpeg';
      for await (const event of textToSpeech.synthesize({
        model,
        text,
        voice,
        format: 'mp3',
        signal,
      })) {
        if (event.type === 'audio_chunk') {
          chunks.push(event.bytes);
          mime = event.mime;
        }
      }
      if (chunks.length === 0) {
        throw new SpeechVoicePreviewError('no_audio', '合成未产生音频');
      }
      return { bytes: concatChunks(chunks), mime };
    } catch (error) {
      if (error instanceof SpeechVoicePreviewError) throw error;
      throw new SpeechVoicePreviewError(
        'synthesis_failed',
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
