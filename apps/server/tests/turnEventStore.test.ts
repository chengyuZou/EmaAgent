// 验证重放缓存耗尽只影响重放能力，不会吞在线事件或 Turn 终态。
import { describe, expect, it } from 'vitest';
import type { TurnStreamEvent } from '@ema-agent/turn';
import { TurnEventStore } from '../src/sse/eventStore.js';

describe('TurnEventStore', () => {
  it('重放预算耗尽后保持在线事件与终态，不接管 Turn 生命周期', () => {
    const store = new TurnEventStore({ maxBytesPerTurn: 1, maxBytesTotal: 1 });
    const delta = {
      type: 'output_text_delta',
      sessionId: 'session',
      turnId: 'turn',
      delta: 'hello',
    } as TurnStreamEvent;
    const completed = {
      type: 'turn_completed',
      sessionId: 'session',
      turnId: 'turn',
    } as TurnStreamEvent;

    expect(store.push('turn', delta).status).toBe('live_only');
    expect(store.push('turn', completed).status).toBe('stored');
    expect(store.isDone('turn')).toBe(true);
    expect(store.replay('turn', 0)).toHaveLength(1);
  });
});
