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
});
