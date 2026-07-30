// 测试活动根 Turn 数量订阅能驱动后台负载判断，并在取消订阅后停止通知。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { RunRegistry } from '../run-registry.js';

describe('RunRegistry 活动 Turn 订阅', () => {
  it('立即发布快照，并只在有效注册与清除后通知', () => {
    const registry = new RunRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    expect(listener).toHaveBeenLastCalledWith(0);

    registry.register(asSessionId('session-a'), asTurnId('turn-a'));
    expect(listener).toHaveBeenLastCalledWith(1);

    registry.clear(asSessionId('missing'));
    expect(listener).toHaveBeenCalledTimes(2);

    registry.clear(asSessionId('session-a'));
    expect(listener).toHaveBeenLastCalledWith(0);

    unsubscribe();
    registry.register(asSessionId('session-b'), asTurnId('turn-b'));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
