// 测试 Turn SSE 重放日志的游标、内存预算、终态与音频脱敏语义。

import {
  describe,
  expect,
  it } from 'vitest';
import { Hono } from 'hono';
import {
  asSessionId,
  asTurnId,
} from '@ema-agent/ids';
import type { TurnStreamEvent } from '@ema-agent/events';
import { TurnEventStore } from '../src/sse/event-store.js';
import { TurnEventHub } from '../src/sse/event-hub.js';
import { encodeEvent } from '../src/sse/writer.js';
import { registerTurnEventRoutes } from '../src/routes/turns/turnEvents.js';

const TURN_ID = asTurnId('turn-1');
const SESSION_ID = asSessionId('session-1');

describe('TurnEventStore', () => {
  it('显式登记空事件槽，让首事件到达前也能识别合法 Turn', () => {
    const store = new TurnEventStore();

    expect(store.has(TURN_ID)).toBe(false);
    store.open(TURN_ID);
    expect(store.has(TURN_ID)).toBe(true);
    expect(store.replay(TURN_ID, 0)).toEqual([]);
  });

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
    const event: TurnStreamEvent = {
      type: 'tts_chunk',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      sentenceId: 'sentence-1',
      mime: 'audio/mpeg',
      audio: 'x'.repeat(10_000),
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

describe('Turn event route', () => {
  it('未知或已经离开重连窗口的 Turn 返回 404，不维持永久心跳', async () => {
    const app = new Hono();
    registerTurnEventRoutes(app, new TurnEventStore(), new TurnEventHub());

    const response = await app.request(`/${TURN_ID}/events`);

    expect(response.status).toBe(404);
  });

  it('拒绝负数、非整数和超出安全整数范围的游标', async () => {
    const app = new Hono();
    const store = new TurnEventStore();
    store.open(TURN_ID);
    registerTurnEventRoutes(app, store, new TurnEventHub());

    for (const cursor of ['-1', '1.5', 'abc', '99999999999999999999']) {
      const response = await app.request(`/${TURN_ID}/events?lastEventId=${cursor}`);
      expect(response.status).toBe(400);
    }
  });
});

function warning(message: string): TurnStreamEvent {
  return { type: 'system_warning', level: 'warn', message };
}
