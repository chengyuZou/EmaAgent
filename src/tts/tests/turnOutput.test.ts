// 测试 Turn 语音输出的终态顺序、失败降级、投影告警和即时音频唤醒。

import { describe, expect, it, vi } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { AudioArchive, FinalizedAudio, SegmentWriter } from '../archive.js';
import type { TtsAdapter, TtsProviderConfig, TtsRequest, TtsStreamEvent } from '../types.js';
import { TtsRuntime } from '../ttsRuntime.js';
import { TurnSpeechOutput, type TurnSpeechSourceEvent } from '../turnOutput.js';

const SESSION_ID = 'session' as SessionId;
const TURN_ID = 'turn' as TurnId;
const FINAL_AUDIO: FinalizedAudio = {
  path: 'turn.mp3',
  mime: 'audio/mpeg',
  byteSize: 1,
  durationMs: null,
  segmentCount: 1,
};
const CONFIG: TtsProviderConfig = {
  id: 'provider',
  protocol: 'openai-tts',
  apiKey: 'test',
  baseUrl: 'https://example.test',
};

interface SourceEvent extends TurnSpeechSourceEvent {
  readonly type: 'output_text_delta' | 'turn_completed' | 'turn_failed';
}

describe('TurnSpeechOutput', () => {
  it('关闭语音时原样透传且不解析合成配置', async () => {
    const resolveSynthesis = vi.fn();
    const output = new TurnSpeechOutput({ resolveSynthesis });

    const events = await collect(output.decorate({
      enabled: false,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      events: sourceEvents({ type: 'turn_completed' }),
    }));

    expect(events.map((event) => event.type)).toEqual(['turn_completed']);
    expect(resolveSynthesis).not.toHaveBeenCalled();
  });

  it('即时音频不会丢失唤醒，且成功终态始终最后发送', async () => {
    const archive = archiveSpy();
    const recordFinalizedAudio = vi.fn();
    const output = speechOutput(immediateAdapter(), archive, recordFinalizedAudio);

    const collecting = collect(output.decorate({
      enabled: true,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      events: sourceEvents(
        { type: 'output_text_delta', delta: '你好。' },
        { type: 'turn_completed' },
      ),
    }));
    const events = await Promise.race([
      collecting,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Turn speech output did not finish')), 1_000);
      }),
    ]);

    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(events.some((event) => event.type === 'tts_chunk')).toBe(true);
    expect(events.some((event) => event.type === 'tts_sentence_complete')).toBe(true);
    expect(recordFinalizedAudio).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      audio: FINAL_AUDIO,
    });
    expect(archive.finalized).toBe(1);
  });

  it('失败终态取消语音并且不写入最终音频投影', async () => {
    const archive = archiveSpy();
    const recordFinalizedAudio = vi.fn();
    const output = speechOutput(immediateAdapter(), archive, recordFinalizedAudio);

    const events = await collect(output.decorate({
      enabled: true,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      events: sourceEvents(
        { type: 'output_text_delta', delta: '不会归档。' },
        { type: 'turn_failed' },
      ),
    }));

    expect(events.at(-1)?.type).toBe('turn_failed');
    expect(recordFinalizedAudio).not.toHaveBeenCalled();
    expect(archive.finalized).toBe(0);
    expect(archive.discarded).toBe(1);
  });

  it('初始化或音频投影失败只产生告警，不改变根 Turn 终态', async () => {
    const setupFailure = new TurnSpeechOutput({
      resolveSynthesis: async () => {
        throw new Error('voice unavailable');
      },
    });
    const setupEvents = await collect(setupFailure.decorate({
      enabled: true,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      events: sourceEvents({ type: 'turn_completed' }),
    }));

    expect(setupEvents.map((event) => event.type)).toEqual([
      'tts_warning',
      'turn_completed',
    ]);

    const projectionFailure = speechOutput(
      immediateAdapter(),
      archiveSpy(),
      async () => {
        throw new Error('database busy');
      },
    );
    const projectionEvents = await collect(projectionFailure.decorate({
      enabled: true,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      events: sourceEvents(
        { type: 'output_text_delta', delta: '仍然完成。' },
        { type: 'turn_completed' },
      ),
    }));

    expect(projectionEvents.at(-2)).toMatchObject({
      type: 'tts_warning',
      code: 'tts/audio_projection_failed',
    });
    expect(projectionEvents.at(-1)?.type).toBe('turn_completed');
  });
});

function speechOutput(
  adapter: TtsAdapter,
  archive: AudioArchive,
  recordFinalizedAudio: (input: {
    sessionId: SessionId;
    turnId: TurnId;
    audio: FinalizedAudio;
  }) => void | Promise<void>,
): TurnSpeechOutput {
  return new TurnSpeechOutput({
    resolveSynthesis: async () => ({
      voice: {
        refAudioPath: 'voice.wav',
        promptText: '',
        promptLang: 'zh',
        providerVoice: { value: 'voice', lifetime: 'durable' },
      },
      providerId: 'provider',
      model: 'model',
      ttsClient: new TtsRuntime({
        configs: [CONFIG],
        adapterOverrides: new Map([['provider', adapter]]),
        usageRecorder: { record: () => undefined },
      }),
      archive,
    }),
    recordFinalizedAudio,
  });
}

function immediateAdapter(): TtsAdapter {
  return adapterWith(async function* () {
    yield {
      type: 'audio_chunk',
      bytes: new Uint8Array([1]),
      mime: 'audio/mpeg',
    };
    yield { type: 'done', totalBytes: 1, firstByteMs: 0 };
  });
}

function adapterWith(
  stream: (request: TtsRequest) => AsyncIterable<TtsStreamEvent>,
): TtsAdapter {
  return {
    protocol: 'openai-tts',
    capabilitiesFor: () => ({
      audioDelivery: 'http_chunks',
      supportsAbort: true,
    }),
    stream,
  };
}

function archiveSpy(): AudioArchive & {
  finalized: number;
  discarded: number;
} {
  return {
    finalized: 0,
    discarded: 0,
    openSegment(): SegmentWriter {
      return {
        write() {},
        close: () => 'segment.mp3',
      };
    },
    async finalizeTurn() {
      this.finalized++;
      return FINAL_AUDIO;
    },
    discardTurn() {
      this.discarded++;
    },
    findMergedFor: () => null,
  };
}

async function* sourceEvents(
  ...events: SourceEvent[]
): AsyncGenerator<SourceEvent, void, void> {
  yield* events;
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}
