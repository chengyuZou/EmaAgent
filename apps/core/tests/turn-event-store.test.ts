// 测试 Turn SSE 重放日志的游标、内存预算、终态与音频脱敏语义。

import {
  describe,
  expect,
  it } from 'vitest';
import { asSessionId,
  asTurnId,
} from '@ema-agent/contracts';
import {
  type EmaStreamEvent,
} from '@ema-agent/turn';
import { TurnEventStore } from '../src/sse/event-store.js';
import { encodeEvent } from '../src/sse/writer.js';

const TURN_ID = asTurnId('turn-1');
const SESSION_ID = asSessionId('session-1');

describe('TurnEventStore', () => {
  it('使用绝对游标重放断线后遗漏的事件', () => {
    const store = new TurnEventStore();
    const first = store.push(TURN_ID, warning('first'));
    const second = store.push(TURN_ID, warning('second'));

    expect(first).toMatchObject({ status: 'stored', published: { cursor: 1 } });
    expect(second).toMatchObject({ status: 'stored', published: { cursor: 2 } });
    expect(store.replay(TURN_ID, 1)).toMatchObject([
      { cursor: 2, event: { type: 'system_warning', message: 'second' } },
    ]);
    expect(encodeEvent(warning('second'), 2)).toContain('id: 2\n');
  });

  it('在线音频不进入重放内存，重放只保留事件位置', () => {
    const store = new TurnEventStore({ maxBytesPerTurn: 256, maxBytesTotal: 512 });
    const event: EmaStreamEvent = {
      type: 'tts_chunk',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      sentenceId: 'sentence-1',
      audio: 'x'.repeat(10_000),
      lipsync: [{ t: 0, mouth: 1 }],
    };

    expect(store.push(TURN_ID, event).status).toBe('stored');
    expect(store.replay(TURN_ID, 0)[0]?.event).toMatchObject({
      type: 'tts_chunk',
      audio: '',
    });
  });

  it('超过预算后拒绝普通事件，但仍保存终态供客户端收口', () => {
    const store = new TurnEventStore({ maxBytesPerTurn: 180, maxBytesTotal: 360 });

    expect(store.push(TURN_ID, warning('x'.repeat(500))).status).toBe('overflow');
    expect(store.push(TURN_ID, warning('later')).status).toBe('overflow');
    expect(store.push(TURN_ID, {
      type: 'turn_aborted',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      reason: 'event_store_budget_exceeded',
    }).status).toBe('stored');
    expect(store.isDone(TURN_ID)).toBe(true);
    expect(store.replay(TURN_ID, 0)).toHaveLength(1);
  });
});

function warning(message: string): EmaStreamEvent {
  return { type: 'system_warning', level: 'warn', message };
}
