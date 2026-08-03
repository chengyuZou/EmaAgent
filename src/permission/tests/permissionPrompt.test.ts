// 测试批准界面投影、可信内置免询问和默认无限等待设置。

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import {
  DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  permissionAskTimeoutSetting,
} from '../settings.js';
import type { AskPermissionFn, PermissionRequest } from '../types.js';

function request(): PermissionRequest {
  return {
    tool: {
      id: 'builtin.file.edit',
      name: 'FileEdit',
      description: '编辑指定文件的内容',
    },
    input: { path: 'readme.md' },
    intent: {
      riskLevel: 'medium',
      accessType: 'write',
      targets: [{ path: 'readme.md', accessType: 'write' }],
      promptPolicy: 'whenRequired',
    },
    context: {
      mode: 'default',
      workspaceRoot: path.resolve('D:/workspace'),
      sessionId: asSessionId('session-1'),
      turnId: asTurnId('turn-1'),
      toolCallId: asToolCallId('call-1'),
    },
  };
}

describe('Permission Prompt', () => {
  it('向批准界面投影完整 Tool 身份、风险和路径目标', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'deny' }));
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());

    await engine.authorize(request(), ask);

    expect(ask).toHaveBeenCalledWith({
      toolId: 'builtin.file.edit',
      toolName: 'FileEdit',
      toolDescription: '编辑指定文件的内容',
      input: { path: 'readme.md' },
      riskLevel: 'medium',
      accessType: 'write',
      targets: [{ path: 'readme.md', accessType: 'write' }],
      gateReason: undefined,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
    });
  });

  it('可信内置免普通询问仍会经过 deny 规则', async () => {
    const engine = new PermissionEngine(new InMemoryPermissionRuleStore());
    const trusted = request();
    trusted.intent = {
      riskLevel: 'low',
      accessType: 'read',
      promptPolicy: 'neverForTrustedBuiltin',
    };
    const ask = vi.fn<AskPermissionFn>();

    expect(await engine.authorize(trusted, ask)).toEqual({
      outcome: 'allow',
      reason: { type: 'promptPolicy', policy: 'neverForTrustedBuiltin' },
    });
    expect(ask).not.toHaveBeenCalled();

    engine.saveRule({ action: 'deny', tool: trusted.tool.id, scope: 'global' });
    expect(await engine.authorize(trusted, ask)).toMatchObject({
      outcome: 'deny',
      reason: { type: 'rule' },
    });
  });

  it('默认不配置超时，只有显式数字才启用自动拒绝', () => {
    expect(DEFAULT_PERMISSION_ASK_TIMEOUT_MS).toBeNull();
    expect(permissionAskTimeoutSetting.decode(null)).toEqual({ ok: true, value: null });
    expect(permissionAskTimeoutSetting.decode(30_000)).toEqual({ ok: true, value: 30_000 });
    expect(permissionAskTimeoutSetting.decode(1_000)).toEqual({ ok: false });
  });
});
