import { randomUUID } from 'node:crypto';
import { createTTSCall, createTTSVoiceRegistrar, packPcmWav, TTSError, type PcmAudioFormat } from '@ema-agent/tts';
import type { UsageRecorder } from '@ema-agent/usage';
import type { StartTurnSpeechInput } from './speechGenerator.js';
import { VoiceRegistrationCache } from './voiceRegistrationCache.js';
import { SpeechVoicePreviewError } from './errors.js';

const MAX_PREVIEW_PCM_BYTES = 16 * 1024 * 1024;

export interface VoicePreviewInput extends Omit<StartTurnSpeechInput, 'sessionId' | 'turnId'> {
  readonly text: string;
}

export interface SpeechVoicePreviewResult {
  readonly bytes: Uint8Array;
  readonly mime: 'audio/wav';
}

/** 试听只返回内存 WAV, 不建立 Turn 音频记录, 也不触发自动播放或字幕. */
export async function generateVoicePreview(
  input: VoicePreviewInput,
  voiceRegistrationCache: VoiceRegistrationCache,
  usageRecorder: UsageRecorder,
): Promise<SpeechVoicePreviewResult> {
  const startedAt = Date.now();
  let errorCode: string | null = null;
  let status: 'completed' | 'failed' | 'cancelled' = 'completed';
  try {
    const voice = await voiceRegistrationCache.prepare({
      reference: input.voiceReference,
      ttsVoiceRegistrar: createTTSVoiceRegistrar(input.connection, input.modelId),
      characterName: input.characterName,
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const callTTS = createTTSCall(input.connection, input.modelId);
    const chunks: Uint8Array[] = [];
    let format: PcmAudioFormat | undefined;
    let receivedPCMBytes = 0;
    for await (const event of callTTS({
      text: input.text,
      voice,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (event.type === 'audio_started') {
        format = event;
      } else if (event.type === 'audio_chunk') {
        receivedPCMBytes += event.bytes.byteLength;
        if (receivedPCMBytes > MAX_PREVIEW_PCM_BYTES) {
          throw new TTSError('tts/resource_exhausted', 'TTS preview exceeds 16 MiB of PCM');
        }
        chunks.push(event.bytes);
      }
    }
    input.signal?.throwIfAborted();
    return { bytes: packPcmWav(chunks, format!), mime: 'audio/wav' };
  } catch (error) {
    const cancelled = input.signal?.aborted === true
      || (error instanceof Error && error.name === 'AbortError')
      || (error instanceof TTSError && error.code === 'tts/aborted');
    status = cancelled ? 'cancelled' : 'failed';
    if (cancelled) errorCode = 'tts/aborted';
    else if (error instanceof TTSError) errorCode = error.code;
    else errorCode = 'tts/preview_failed';
    throw new SpeechVoicePreviewError('synthesis_failed', error instanceof Error ? error.message : String(error), error);
  } finally {
    usageRecorder.record({
      id: randomUUID(),
      sessionId: null,
      turnId: null,
      capability: 'tts',
      providerId: input.providerId,
      modelId: input.modelId,
      status,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      durationMs: Date.now() - startedAt,
      quantity: input.text.length,
      unit: 'character',
      errorCode,
      createdAt: startedAt,
    });
  }
}
