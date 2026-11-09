import { describe, expect, it, vi } from 'vitest';
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import type { StartTurnSpeechInput, SpeechGenerationResult } from '@ema-agent/speech';
import { TurnFanout } from '../src/application/turnFanout.js';

const started = {
  type: 'turn_started', sessionId: 'session', turnId: 'turn',
  triggerType: 'userMessage', ttsEnabled: true,
} as const satisfies TurnStreamEvent;

function handleWith(events: readonly TurnStreamEvent[]): TurnHandle {
  return {
    sessionId: 'session', turnId: 'turn',
    events: (async function* () { for (const event of events) yield event; })(),
    completion: new Promise(() => {}), abort: vi.fn(),
  };
}

function fixture() {
  const identity = { sessionId: 'session', turnId: 'turn', characterName: '艾玛', audioId: 'audio' };
  const speechGenerator = {
    startTurnSpeech: vi.fn(() => ({ ...identity, generationCompletion: new Promise<SpeechGenerationResult>(() => {}) })),
    appendTextDelta: vi.fn(), endTextInput: vi.fn(),
  };
  const createTurnSpeechInput = vi.fn((_sessionId, _turnId, _characterName, signal): StartTurnSpeechInput => ({
    ...identity, signal, providerId: 'provider', modelId: 'model', connection: { protocol: 'gpt-sovits-tts' },
    voiceReference: {
      kind: 'reference', resourceName: 'voice.wav', resourceUpdatedAt: 1, registrationName: 'voice',
      audioPath: 'voice.wav', promptText: '参考', promptLanguage: 'zh',
    },
  }));
  const publishTurnEvent = vi.fn();
  return { identity, speechGenerator, publishTurnEvent, fanout: new TurnFanout({
    speech: { speechGenerator, createTurnSpeechInput }, publishTurnEvent, emitAppEvent: vi.fn(),
  }) };
}

describe('TurnFanout', () => {
  it('关闭 TTS 时不创建语音, 启动消息明确没有 AudioID', async () => {
    const { fanout, speechGenerator, publishTurnEvent } = fixture();
    fanout.attach(handleWith([{ ...started, ttsEnabled: false }]));
    await vi.waitFor(() => expect(publishTurnEvent).toHaveBeenCalledOnce());
    expect(speechGenerator.startTurnSpeech).not.toHaveBeenCalled();
    expect(publishTurnEvent.mock.calls[0]?.[2]).toMatchObject({ ttsEnabled: false, audioId: null });
  });

  it('自动启动公开指定 AudioID, 文字标签按顺序交付, 正文完成不等播放', async () => {
    const { fanout, speechGenerator, publishTurnEvent } = fixture();
    const tags = [{ type: 'emotion', emotion: 'happy' }] as const;
    fanout.attach(handleWith([
      started,
      { type: 'output_text_delta', sessionId: 'session', turnId: 'turn', blockIndex: 0, delta: '前文', tags, assistantMessageId: 'message' },
      { type: 'turn_completed', sessionId: 'session', turnId: 'turn' },
    ]));
    await vi.waitFor(() => expect(publishTurnEvent).toHaveBeenCalledTimes(3));
    expect(publishTurnEvent.mock.calls[0]?.[2]).toMatchObject({ audioId: 'audio', characterName: '艾玛' });
    expect(speechGenerator.appendTextDelta).toHaveBeenCalledWith('audio', '前文', tags);
    expect(speechGenerator.endTextInput).toHaveBeenCalledWith('audio');
  });
});
