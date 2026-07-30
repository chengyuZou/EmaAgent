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

  it('永久删除前阻止新 Turn、排空 Memory，再删除数据并清理软引用', async () => {
    const calls: string[] = [];
    const fixture = createFixture(calls);
    const sessionId = asSessionId('session-a');

    await fixture.lifecycle.deleteSession(sessionId);

    expect(calls).toEqual([
      'begin-deletion',
      'cancel-interactions',
      'clear-permissions',
      'remove-runtime',
      'memory-before-delete',
      'delete-session',
      'memory-after-delete',
    ]);
  });

  it('Memory 准备失败时恢复 Session 与 Extraction 入口', async () => {
    const calls: string[] = [];
    const fixture = createFixture(calls, { failMemoryPreparation: true });
    const sessionId = asSessionId('session-a');

    await expect(fixture.lifecycle.deleteSession(sessionId)).rejects.toThrow(
      'memory preparation failed',
    );
    expect(calls).toEqual([
      'begin-deletion',
      'cancel-interactions',
      'clear-permissions',
      'remove-runtime',
      'memory-before-delete',
      'memory-cancel-delete',
      'cancel-deletion',
    ]);
  });

  it('Data DB 已删除但派生文件清理失败时仍完成 Memory 后清理', async () => {
    const calls: string[] = [];
    const fixture = createFixture(calls, { failAfterDataDeletion: true });
    const sessionId = asSessionId('session-a');

    await expect(fixture.lifecycle.deleteSession(sessionId)).rejects.toThrow(
      'derived file cleanup failed',
    );
    expect(calls).toEqual([
      'begin-deletion',
      'cancel-interactions',
      'clear-permissions',
      'remove-runtime',
      'memory-before-delete',
      'delete-session',
      'memory-after-delete',
    ]);
  });
});

function createFixture(
  calls: string[] = [],
  options: {
    failMemoryPreparation?: boolean;
    failAfterDataDeletion?: boolean;
  } = {},
) {
  const invalidateSessionRuntime = vi.fn();
  let sessionExists = true;
  const lifecycle = new SessionLifecycle({
    session: {
      patchSession: vi.fn(),
      getSession: vi.fn(() => ({ id: 'session-a' }) as never),
      sessionExists: vi.fn(() => sessionExists),
      beginSessionDeletion: vi.fn(() => calls.push('begin-deletion')),
      cancelSessionDeletion: vi.fn(() => calls.push('cancel-deletion')),
      deleteSession: vi.fn(() => {
        calls.push('delete-session');
        sessionExists = false;
        if (options.failAfterDataDeletion) {
          throw new Error('derived file cleanup failed');
        }
      }),
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
    memory: {
      beforeSessionDelete: vi.fn(async () => {
        calls.push('memory-before-delete');
        if (options.failMemoryPreparation) {
          throw new Error('memory preparation failed');
        }
      }),
      afterSessionDelete: vi.fn(async () => {
        calls.push('memory-after-delete');
      }),
      cancelSessionDelete: vi.fn(() => calls.push('memory-cancel-delete')),
    },
  });
  return { lifecycle, invalidateSessionRuntime };
}
