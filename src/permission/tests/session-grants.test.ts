// 这里测试同一 Session 的临时授权能否正确复用、隔离和清理。

import { describe, expect, it, vi } from 'vitest';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import type { AskPermissionFn, PermissionContext, ToolPermissionMeta } from '../types.js';

const meta: ToolPermissionMeta = {
  riskLevel: 'high',
  accessType: 'execute',
};

function context(sessionId: string, ask: AskPermissionFn): PermissionContext {
  return {
    workspaceRoot: 'D:\\workspace',
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId: `call-${sessionId}`,
    ask,
  };
}

describe('PermissionEngine Session Grant', () => {
  it('只在同一 Session 复用完全相同的规范化操作', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allow_session' }));
    const engine = new PermissionEngine({ mode: 'ask', ask }, new InMemoryPermissionRuleStore());

    const first = await engine.gate(
      'shell_command',
      { command: 'npm test', options: { cwd: 'app', timeout: 30 } },
      meta,
      context('session-a', ask),
    );
    const sameWithDifferentKeyOrder = await engine.gate(
      'shell_command',
      { options: { timeout: 30, cwd: 'app' }, command: 'npm test' },
      meta,
      context('session-a', ask),
    );

    expect(first.granted).toBe(true);
    expect(sameWithDifferentKeyOrder).toEqual({
      granted: true,
      decisionReason: { type: 'sessionGrant', sessionId: 'session-a' },
    });
    expect(ask).toHaveBeenCalledTimes(1);

    await engine.gate(
      'shell_command',
      { command: 'npm publish', options: { cwd: 'app', timeout: 30 } },
      meta,
      context('session-a', ask),
    );
    await engine.gate(
      'shell_command',
      { command: 'npm test', options: { cwd: 'app', timeout: 30 } },
      meta,
      context('session-b', ask),
    );

    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('Session 清理后撤销临时授权，且新增 deny 规则始终优先', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allow_session' }));
    const engine = new PermissionEngine({ mode: 'ask', ask }, new InMemoryPermissionRuleStore());
    const input = { command: 'npm test' };
    const ctx = context('session-a', ask);

    await engine.gate('shell_command', input, meta, ctx);
    const denyRule = engine.addRule({ action: 'deny', tool: 'shell_command', scope: 'global' });
    const denied = await engine.gate('shell_command', input, meta, ctx);

    expect(denied.granted).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);

    engine.removeRule(denyRule.id);
    engine.clearSession('session-a');
    await engine.gate('shell_command', input, meta, ctx);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('缺少 sessionId 时不会把 allow_session 降级成全局授权', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allow_session' }));
    const engine = new PermissionEngine({ mode: 'ask', ask }, new InMemoryPermissionRuleStore());

    const outcome = await engine.gate('shell_command', { command: 'npm test' }, meta, {
      workspaceRoot: 'D:\\workspace',
      ask,
    });

    expect(outcome).toEqual(expect.objectContaining({
      granted: false,
      reason: 'session-scoped approval requires a sessionId',
    }));
  });

  it('审批等待期间解析目标变化时拒绝执行和缓存授权', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allow_session' }));
    let extraction = 0;
    const changingMeta: ToolPermissionMeta = {
      riskLevel: 'high',
      accessType: 'write',
      extractPath: () => extraction++ === 0
        ? 'D:\\workspace-a\\first.txt'
        : 'D:\\workspace-b\\second.txt',
    };
    const engine = new PermissionEngine({ mode: 'ask', ask }, new InMemoryPermissionRuleStore());

    const outcome = await engine.gate(
      { id: 'builtin.file.write', name: 'Write' },
      { path: 'target.txt', content: 'hello' },
      changingMeta,
      context('session-a', ask),
    );

    expect(outcome).toEqual(expect.objectContaining({
      granted: false,
      reason: 'permission target changed while awaiting approval',
    }));
  });
});

