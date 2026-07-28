// 测试 Session 工作区变更和永久删除会按固定顺序收口跨模块状态。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@ema-agent/ids';
import { SessionLifecycle } from '../sessionLifecycle.js';

describe('SessionLifecycle', () => {
  it('只在显式修改工作区时使运行时缓存失效', () => {
    const fixture = createFixture();
    const sessionId = asSessionId('session-a');

    fixture.lifecycle.updateSession(sessionId, { title: '新标题' });
    expect(fixture.invalidateSessionRuntime).not.toHaveBeenCalled();

    fixture.lifecycle.updateSession(sessionId, { workspaceRoot: null });
    expect(fixture.invalidateSessionRuntime).toHaveBeenCalledOnce();
    expect(fixture.invalidateSessionRuntime).toHaveBeenCalledWith(sessionId);
  });

  it('永久删除前取消交互、清除授权并释放运行时', () => {
    const calls: string[] = [];
    const fixture = createFixture(calls);
    const sessionId = asSessionId('session-a');

    fixture.lifecycle.deleteSession(sessionId);

    expect(calls).toEqual([
      'cancel-interactions',
      'clear-permissions',
      'remove-runtime',
      'delete-session',
    ]);
  });
});

function createFixture(calls: string[] = []) {
  const invalidateSessionRuntime = vi.fn();
  const lifecycle = new SessionLifecycle({
    session: {
      patchSession: vi.fn(),
      getSession: vi.fn(() => ({ id: 'session-a' }) as never),
      deleteSession: vi.fn(() => calls.push('delete-session')),
    },
    runtime: {
      invalidateSessionRuntime,
      removeSessionRuntime: vi.fn(() => calls.push('remove-runtime')),
    },
    interactions: {
      cancelForSession: vi.fn(() => calls.push('cancel-interactions')),
    },
    permissions: {
      clearSession: vi.fn(() => calls.push('clear-permissions')),
    },
  });
  return { lifecycle, invalidateSessionRuntime };
}
