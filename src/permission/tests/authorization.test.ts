// 测试 Permission 公共入口的规则优先级、执行模式和多目标覆盖语义。

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import type { AskPermissionFn, PermissionRequest } from '../types.js';

const workspaceRoot = path.resolve('D:/workspace');

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: { id: 'builtin.file.write', name: 'FileWrite' },
    input: { path: 'notes.txt', content: 'hello' },
    intent: {
      riskLevel: 'medium',
      accessType: 'write',
      targets: [{ path: 'notes.txt', accessType: 'write' }],
      promptPolicy: 'whenRequired',
    },
    context: {
      mode: 'default',
      workspaceRoot,
    },
    ...overrides,
  };
}

describe('PermissionEngine 授权顺序', () => {
  it('default 自动放行工作区读取，acceptEdits 只额外放行工作区写入', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());

    const read = await engine.authorize(request({
      intent: {
        riskLevel: 'low',
        accessType: 'read',
        targets: [{ path: 'notes.txt', accessType: 'read' }],
        promptPolicy: 'whenRequired',
      },
    }));
    const write = await engine.authorize(request({
      context: { mode: 'acceptEdits', workspaceRoot },
    }));
    const execute = await engine.authorize(request({
      tool: { id: 'builtin.shell', name: 'Bash' },
      input: { command: 'npm test' },
      intent: {
        riskLevel: 'high',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
      context: { mode: 'acceptEdits', workspaceRoot },
    }));

    expect(read).toEqual({ outcome: 'allow', reason: { type: 'workspace' } });
    expect(write).toEqual({
      outcome: 'allow',
      reason: { type: 'mode', mode: 'acceptEdits' },
    });
    expect(execute).toMatchObject({ outcome: 'deny', reason: { type: 'headless' } });
  });

  it('deny 和 ask 规则都优先于 bypassPermissions', async () => {
    const store = new InMemoryPermissionRuleStore();
    const engine = new PermissionEngine(store, { allowBypassPermissions: true });
    engine.saveRule({ action: 'deny', tool: 'builtin.shell', scope: 'global' });

    const denied = await engine.authorize(request({
      tool: { id: 'builtin.shell', name: 'Bash' },
      input: { command: 'npm test' },
      intent: {
        riskLevel: 'high',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
      context: { mode: 'bypassPermissions', workspaceRoot },
    }));

    expect(denied).toMatchObject({ outcome: 'deny', reason: { type: 'rule' } });

    engine.removeRule(engine.listRules()[0]!.id);
    engine.saveRule({ action: 'ask', tool: 'builtin.shell', scope: 'global' });
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'allow' }));
    const allowed = await engine.authorize(request({
      tool: { id: 'builtin.shell', name: 'Bash' },
      input: { command: 'npm test' },
      intent: {
        riskLevel: 'high',
        accessType: 'execute',
        promptPolicy: 'whenRequired',
      },
      context: { mode: 'bypassPermissions', workspaceRoot },
    }), ask);

    expect(ask).toHaveBeenCalledOnce();
    expect(allowed).toMatchObject({ outcome: 'allow', reason: { type: 'user' } });
  });

  it('allow 规则必须覆盖多目标的全部原路径和真实路径', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    engine.saveRule({
      action: 'allow',
      tool: 'builtin.file.copy',
      pathGlob: 'allowed/**',
      scope: 'workspace',
      workspaceRoot,
    });

    const result = await engine.authorize(request({
      tool: { id: 'builtin.file.copy', name: 'FileCopy' },
      input: { from: 'allowed/a.txt', to: 'outside/b.txt' },
      intent: {
        riskLevel: 'medium',
        accessType: 'write',
        targets: [
          { path: 'allowed/a.txt', accessType: 'read' },
          { path: 'outside/b.txt', accessType: 'write' },
        ],
        promptPolicy: 'whenRequired',
      },
    }));

    expect(result).toMatchObject({ outcome: 'deny', reason: { type: 'headless' } });

    engine.saveRule({
      action: 'allow',
      tool: 'builtin.file.copy',
      pathGlob: 'outside/**',
      scope: 'workspace',
      workspaceRoot,
    });
    const fullyCovered = await engine.authorize(request({
      tool: { id: 'builtin.file.copy', name: 'FileCopy' },
      input: { from: 'allowed/a.txt', to: 'outside/b.txt' },
      intent: {
        riskLevel: 'medium',
        accessType: 'write',
        targets: [
          { path: 'allowed/a.txt', accessType: 'read' },
          { path: 'outside/b.txt', accessType: 'write' },
        ],
        promptPolicy: 'whenRequired',
      },
    }));

    expect(fullyCovered).toMatchObject({
      outcome: 'allow',
      reason: { type: 'rule', rules: [{ pathGlob: 'allowed/**' }, { pathGlob: 'outside/**' }] },
    });
  });
});
