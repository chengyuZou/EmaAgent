// 测试 Session 精确授权以及等待批准期间请求被替换时的拒绝行为。

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import type { AskPermissionFn, PermissionRequest } from '../types.js';

function request(session = 'session-a'): PermissionRequest {
  return {
    tool: { id: 'builtin.shell', name: 'Bash' },
    input: { command: 'npm test', options: { cwd: 'app', timeout: 30 } },
    intent: {
      riskLevel: 'high',
      accessType: 'execute',
      promptPolicy: 'whenRequired',
    },
    context: {
      mode: 'default',
      workspaceRoot: path.resolve('D:/workspace'),
      sessionId: session,
      turnId: `turn-${session}`,
      toolCallId: `call-${session}`,
    },
  };
}

describe('Permission 请求完整性', () => {
  it('本会话授权只复用规范化后完全相同的请求', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allowSession' }));
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const first = request();

    expect(await engine.authorize(first, ask)).toMatchObject({ outcome: 'allow' });
    const reordered: PermissionRequest = {
      ...request(),
      input: {
        options: { timeout: 30, cwd: 'app' },
        command: 'npm test',
      },
    };
    expect(await engine.authorize(reordered, ask)).toMatchObject({
      outcome: 'allow',
      reason: { type: 'sessionGrant' },
    });

    const changed: PermissionRequest = {
      ...request(),
      input: { command: 'npm publish', options: { cwd: 'app', timeout: 30 } },
    };
    await engine.authorize(changed, ask);
    await engine.authorize(request('session-b'), ask);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('批准等待期间输入变化时拒绝执行，也不保存 Session 授权', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const mutableInput = { command: 'npm test', options: { cwd: 'app', timeout: 30 } };
    const pending: PermissionRequest = { ...request(), input: mutableInput };
    const ask = vi.fn<AskPermissionFn>(async () => {
      mutableInput.command = 'npm publish';
      return { action: 'allowSession' };
    });

    const result = await engine.authorize(pending, ask);

    expect(result).toEqual({
      outcome: 'deny',
      message: '等待批准期间请求或目标发生变化，已拒绝执行',
      reason: { type: 'requestChanged' },
    });
  });

  it('缺少 sessionId 时不把 allowSession 降级成更宽授权', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const pending: PermissionRequest = {
      ...request(),
      context: { mode: 'default', workspaceRoot: path.resolve('D:/workspace') },
    };

    const result = await engine.authorize(
      pending,
      async () => ({ action: 'allowSession' }),
    );

    expect(result).toMatchObject({ outcome: 'deny', reason: { type: 'invalidRequest' } });
  });
});
