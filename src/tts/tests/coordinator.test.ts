// 测试 TTS Coordinator 的并发完成、取消和归档终态。
import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, SessionId, TurnId } from '@ema-agent/contracts';
import { TtsCoordinator } from '../coordinator.js';
import { TtsRuntime } from '../ttsRuntime.js';
import type { AudioArchive, FinalizedAudio, SegmentWriter } from '../archive.js';
import type { TtsAdapter, TtsProviderConfig, TtsRequest, TtsStreamEvent } from '../types.js';

const CONFIG: TtsProviderConfig = {
  id: 'provider',
  protocol: 'openai-tts',
  apiKey: 'test',
  baseUrl: 'https://example.test',
};

function adapterWith(stream: (req: TtsRequest) => AsyncIterable<TtsStreamEvent>): TtsAdapter {
  return {
    protocol: 'openai-tts',
    capabilitiesFor: () => ({ audioDelivery: 'http_chunks', supportsAbort: true }),
    stream,
  };
}

function archiveSpy(): AudioArchive & { finalized: number; discarded: number } {
  const finalizedAudio: FinalizedAudio = {
    path: 'turn.mp3', mime: 'audio/mpeg', byteSize: 1, durationMs: null, segmentCount: 1,
  };
  return {
    finalized: 0,
    discarded: 0,
    openSegment(): SegmentWriter {
      return { write() {}, close: () => 'segment.mp3' };
    },
    async finalizeTurn() {
      this.finalized++;
      return finalizedAudio;
    },
    discardTurn() { this.discarded++; },
    findMergedFor: () => null,
  };
}

function coordinator(
  adapter: TtsAdapter,
  archive: AudioArchive,
  emit: (event: EmaStreamEvent) => void,
): TtsCoordinator {
  return new TtsCoordinator({
    turnId: 'turn' as TurnId,
    sessionId: 'session' as SessionId,
    voice: { refAudioPath: 'voice.wav', promptText: '', promptLang: 'zh', voiceUri: 'voice' },
    providerId: 'provider',
    model: 'model',
    ttsClient: new TtsRuntime({
      configs: [CONFIG],
      adapterOverrides: new Map([['provider', adapter]]),
    }),
    emit,
    archive,
  });
}

describe('TtsCoordinator 终态', () => {
  it('并发 finish 共享同一个 Promise 且只归档一次', async () => {
    const archive = archiveSpy();
    const adapter = adapterWith(async function* () {
      yield { type: 'audio_chunk', bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
      yield { type: 'done', totalBytes: 1, firstByteMs: 1 };
    });
    const instance = coordinator(adapter, archive, () => undefined);
    instance.acceptTextDelta('你好。');

    const first = instance.finish();
    const second = instance.finish();
    expect(first).toBe(second);
    await first;
    expect(archive.finalized).toBe(1);
  });

  it('abort 后丢弃迟到事件并禁止 finalize', async () => {
    const archive = archiveSpy();
    let firstChunk!: () => void;
    const sawFirstChunk = new Promise<void>((resolve) => { firstChunk = resolve; });
    const emitted: EmaStreamEvent[] = [];
    const adapter = adapterWith(async function* (req) {
      yield { type: 'audio_chunk', bytes: new Uint8Array([1]), mime: 'audio/mpeg' };
      await new Promise<void>((resolve) => {
        req.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'audio_chunk', bytes: new Uint8Array([2]), mime: 'audio/mpeg' };
      yield { type: 'done', totalBytes: 2, firstByteMs: 1 };
    });
    const instance = coordinator(adapter, archive, (event) => {
      emitted.push(event);
      if (event.type === 'tts_chunk') firstChunk();
    });
    instance.acceptTextDelta('你好。');
    const finishing = instance.finish();
    await sawFirstChunk;
    await instance.abort();
    await finishing;

    expect(emitted.filter((event) => event.type === 'tts_chunk')).toHaveLength(1);
    expect(emitted.some((event) => event.type === 'tts_sentence_complete')).toBe(false);
    expect(archive.finalized).toBe(0);
    expect(archive.discarded).toBe(1);
  });
});
