// 测试 ActiveSessionRegistry：kind 标签、身份匹配取消与 Session 删除的坑位释放等待。
import { describe, expect, it } from 'vitest';
import { ActiveSessionRegistry } from '../activeSessionRegistry.js';

describe('ActiveSessionRegistry', () => {
  it('register 记录 kind，getActiveExecution 返回身份与 kind', () => {
    const registry = new ActiveSessionRegistry();
    registry.register('s1', 'exec-1', 'compact');
    expect(registry.getActiveExecution('s1')).toEqual({
      executionId: 'exec-1',
      kind: 'compact',
    });
  });

  it('waitUntilIdle：无占用立即返回；占用时 clear 后放行；discardSession 也放行', async () => {
    const registry = new ActiveSessionRegistry();
    await registry.waitUntilIdle('s0');

    registry.register('s1', 'exec-1', 'turn');
    let resolved = false;
    const pending = registry.waitUntilIdle('s1').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    registry.clear('s1', 'exec-1');
    await pending;
    expect(resolved).toBe(true);

    registry.register('s2', 'exec-2', 'compact');
    const discarded = registry.waitUntilIdle('s2');
    registry.discardSession('s2');
    await discarded;
  });

  it('clear 只清身份匹配的条目，迟到清理不影响 waitUntilIdle', async () => {
    const registry = new ActiveSessionRegistry();
    registry.register('s1', 'exec-1', 'compact');
    expect(registry.clear('s1', 'other')).toBe(false);

    const pending = registry.waitUntilIdle('s1');
    registry.clear('s1', 'exec-1');
    await pending;
  });

  it('abortAll 并发通知全部 Turn 与 Compact，并等待执行所有者清理', async () => {
    const registry = new ActiveSessionRegistry();
    const turnSignal = registry.register('s1', 'turn-1', 'turn');
    const compactSignal = registry.register('s2', 'compact-1', 'compact');
    turnSignal.addEventListener('abort', () => registry.clear('s1', 'turn-1'));
    compactSignal.addEventListener('abort', () => registry.clear('s2', 'compact-1'));

    await registry.abortAll();

    expect(turnSignal.aborted).toBe(true);
    expect(compactSignal.aborted).toBe(true);
    expect(registry.activeSessionCount()).toBe(0);
  });

  it('关闭窗口同步拒绝新注册，并把并发关闭操作串行执行', async () => {
    const registry = new ActiveSessionRegistry();
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

    expect(() => registry.register('s1', 'turn-1', 'turn')).toThrow('session_busy');
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(registry.register('s1', 'turn-2', 'turn').aborted).toBe(false);
  });
});
