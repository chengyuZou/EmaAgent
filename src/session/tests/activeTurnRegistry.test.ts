// 测试活动根 Turn 的身份隔离、数量订阅与取消清理。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { ActiveTurnRegistry } from '../activeTurnRegistry.js';

describe('ActiveTurnRegistry 活动 Turn 身份与订阅', () => {
  it('立即发布快照，并只在有效注册与清除后通知', () => {
    const registry = new ActiveTurnRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const sessionA = asSessionId('session-a');
    const turnA = asTurnId('turn-a');

    expect(listener).toHaveBeenLastCalledWith(0);

    registry.register(sessionA, turnA);
    expect(listener).toHaveBeenLastCalledWith(1);

    registry.clear(asSessionId('missing'), asTurnId('missing'));
    expect(listener).toHaveBeenCalledTimes(2);

    registry.clear(sessionA, turnA);
    expect(listener).toHaveBeenLastCalledWith(0);

    unsubscribe();
    registry.register(asSessionId('session-b'), asTurnId('turn-b'));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('拒绝覆盖已有 Turn，并忽略旧 Turn 的迟到取消与清理', () => {
    const registry = new ActiveTurnRegistry();
    const sessionId = asSessionId('session-a');
    const firstTurnId = asTurnId('turn-a');
    const nextTurnId = asTurnId('turn-b');
    const firstSignal = registry.register(sessionId, firstTurnId);

    expect(() => registry.register(sessionId, nextTurnId))
      .toThrow('active_turn_already_registered');
    expect(registry.abort(sessionId, nextTurnId)).toBe(false);
    expect(firstSignal.aborted).toBe(false);
    expect(registry.clear(sessionId, nextTurnId)).toBe(false);
    expect(registry.getActiveTurnId(sessionId)).toBe(firstTurnId);
  });

  it('观察者抛错不会破坏活动 Turn 的注册与释放', () => {
    const registry = new ActiveTurnRegistry();
    const sessionId = asSessionId('session-a');
    const turnId = asTurnId('turn-a');
    registry.subscribe(() => {
      throw new Error('observer failed');
    });

    const signal = registry.register(sessionId, turnId);
    expect(signal.aborted).toBe(false);
    expect(registry.getActiveTurnId(sessionId)).toBe(turnId);
    expect(registry.clear(sessionId, turnId)).toBe(true);
    expect(registry.activeSessionCount()).toBe(0);
  });
});
