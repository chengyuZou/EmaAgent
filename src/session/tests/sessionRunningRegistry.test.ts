// 测试 SessionRunningRegistry 的身份匹配取消、清理等待和注册关闭窗口.
import { describe, expect, it } from 'vitest';
import { SessionRunningRegistry } from '../sessionRunningRegistry.js';

describe('SessionRunningRegistry', () => {
  it('注册和清除只发布 session running 当前值变化', () => {
    const registry = new SessionRunningRegistry();
    const changes: unknown[] = [];
    const stop = registry.subscribe((sessionId, running) => {
      changes.push({ sessionId, running });
    });
    const turn = { kind: 'turn', turnId: 'turn-1' } as const;

    registry.register('s1', turn);
    registry.clear('s1', turn);
    stop();
    registry.register('s2', { kind: 'compact', compactId: 'compact-1' });

    expect(changes).toEqual([
      { sessionId: 's1', running: turn },
      { sessionId: 's1', running: null },
    ]);
  });

  it('register 记录根 Turn 或手动 Compact 的真实身份', () => {
    const registry = new SessionRunningRegistry();
    registry.register('s1', { kind: 'compact', compactId: 'compact-1' });
    expect(registry.getRunning('s1')).toEqual({
      compactId: 'compact-1',
      kind: 'compact',
    });
  });

  it('waitUntilIdle 在运行记录清除后放行', async () => {
    const registry = new SessionRunningRegistry();
    await registry.waitUntilIdle('s0');

    const turn = { kind: 'turn', turnId: 'turn-1' } as const;
    registry.register('s1', turn);
    let resolved = false;
    const pending = registry.waitUntilIdle('s1').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    registry.clear('s1', turn);
    await pending;
    expect(resolved).toBe(true);

    registry.register('s2', { kind: 'compact', compactId: 'compact-2' });
    const discarded = registry.waitUntilIdle('s2');
    registry.discardSession('s2');
    await discarded;
  });

  it('clear 只清除身份匹配的运行记录', async () => {
    const registry = new SessionRunningRegistry();
    const compact = { kind: 'compact', compactId: 'compact-1' } as const;
    registry.register('s1', compact);
    expect(registry.clear('s1', { kind: 'compact', compactId: 'other' })).toBe(false);

    const pending = registry.waitUntilIdle('s1');
    registry.clear('s1', compact);
    await pending;
  });

  it('abortAll 通知全部根 Turn 与手动 Compact, 并等待执行所有者清理', async () => {
    const registry = new SessionRunningRegistry();
    const turn = { kind: 'turn', turnId: 'turn-1' } as const;
    const compact = { kind: 'compact', compactId: 'compact-1' } as const;
    const turnSignal = registry.register('s1', turn);
    const compactSignal = registry.register('s2', compact);
    turnSignal.addEventListener('abort', () => registry.clear('s1', turn));
    compactSignal.addEventListener('abort', () => registry.clear('s2', compact));

    await registry.abortAll();

    expect(turnSignal.aborted).toBe(true);
    expect(compactSignal.aborted).toBe(true);
    expect(registry.runningSessionCount()).toBe(0);
  });

  it('注册关闭窗口拒绝新工作, 并把并发关闭操作串行执行', async () => {
    const registry = new SessionRunningRegistry();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = registry.runWithRegistrationsClosed(async () => {
      order.push('first-start');
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      order.push('first-end');
    });
    const second = registry.runWithRegistrationsClosed(() => {
      order.push('second');
    });

    expect(() => registry.register('s1', { kind: 'turn', turnId: 'turn-1' })).toThrow('session_busy');
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(registry.register('s1', { kind: 'turn', turnId: 'turn-2' }).aborted).toBe(false);
  });
});
