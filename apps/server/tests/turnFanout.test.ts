// 验证 TurnFanout 把本轮真实 TTS 选择随事件发布, 且关闭 TTS 时不启动 Speech 管线.
import { describe, expect, it, vi } from 'vitest';
import type { TurnHandle, TurnStreamEvent } from '@ema-agent/turn';
import { TurnFanout } from '../src/application/turnFanout.js';

const TURN_STARTED = {
  type: 'turn_started',
  sessionId: 'session-1',
  turnId: 'turn-1',
  triggerType: 'userMessage',
  sessionMode: 'chat',
  narrativePolicy: 'auto',
  ttsEnabled: false,
} as const satisfies TurnStreamEvent;

function handleWith(events: readonly TurnStreamEvent[]): TurnHandle {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    completion: new Promise(() => {}),
    abort: vi.fn(),
  };
}

describe('TurnFanout', () => {
  it('关闭 TTS 时发布 false 且不创建 Speech', async () => {
    const publishTurnEvent = vi.fn();
    const startTurnSpeech = vi.fn();
    const fanout = new TurnFanout({
      publishTurnEvent,
      startTurnSpeech,
      emitAppEvent: vi.fn(),
    });

    fanout.attach(handleWith([TURN_STARTED]));

    await vi.waitFor(() => expect(publishTurnEvent).toHaveBeenCalledOnce());
    expect(publishTurnEvent).toHaveBeenCalledWith(
      'session-1',
      'turn-1',
      TURN_STARTED,
    );
    expect(startTurnSpeech).not.toHaveBeenCalled();
  });

  it('开启 TTS 时启动 Speech 并随事件发布 true', async () => {
    const publishTurnEvent = vi.fn();
    const startTurnSpeech = vi.fn(async () => null);
    const fanout = new TurnFanout({
      publishTurnEvent,
      startTurnSpeech,
      emitAppEvent: vi.fn(),
    });

    const startedWithSpeech = { ...TURN_STARTED, ttsEnabled: true };
    fanout.attach(handleWith([startedWithSpeech]));

    await vi.waitFor(() => expect(publishTurnEvent).toHaveBeenCalledOnce());
    expect(startTurnSpeech).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      turnId: 'turn-1',
    }));
    expect(publishTurnEvent).toHaveBeenCalledWith(
      'session-1',
      'turn-1',
      startedWithSpeech,
    );
  });
});
