// 测试 LocalHost 把权限提示完整转换为结构化 SSE，避免展示字段在接线层丢失。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallId, TurnId } from '@ema-agent/ids';
import type { TurnStreamEvent } from '@ema-agent/events';
import type {
  PermissionPrompt,
  PermissionRequest,
} from '@ema-agent/permission';
import { Database } from '@ema-agent/storage';
import { buildPermissionSubsystem } from '../src/wiring/permission-bootstrap.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('permission_required SSE', () => {
  it('保留 Tool 说明、风险等级、访问类型和门禁原因', async () => {
    const database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    try {
      const subsystem = buildPermissionSubsystem(120_000, database.sqlite);
      const events: TurnStreamEvent[] = [];
      const ask = subsystem.buildAskForTurn({
        sessionId: 'session-1',
        turnId: 'turn-1' as TurnId,
        toolCallId: 'call-1' as ToolCallId,
        emit: (event) => events.push(event),
      });
      const prompt: PermissionPrompt = {
        toolId: 'file_edit',
        toolName: 'FileEdit',
        toolDescription: '编辑指定文件的内容',
        input: { path: 'D:/workspace/readme.md' },
        riskLevel: 'medium',
        accessType: 'write',
        targets: [],
        gateReason: '需要修改工作区文件',
      };

      const responsePromise = ask(prompt);
      const required = events[0];
      expect(required).toEqual(expect.objectContaining({
        type: 'permission_required',
        toolId: 'file_edit',
        toolName: 'FileEdit',
        toolDescription: '编辑指定文件的内容',
        riskLevel: 'medium',
        accessType: 'write',
        targets: [],
        gateReason: '需要修改工作区文件',
      }));
      if (!required || required.type !== 'permission_required') {
        throw new Error('permission_required event was not emitted');
      }

      subsystem.interactionQueue.respondPermission(required.promptId, { action: 'allow' });
      await expect(responsePromise).resolves.toEqual({ action: 'allow' });
      expect(events[1]).toEqual(expect.objectContaining({
        type: 'permission_resolved',
        promptId: required.promptId,
        decision: 'allow',
      }));
    } finally {
      database.close();
    }
  });

  it('正式构建拒绝环境变量开启 bypassPermissions', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AGEN_PERMISSION_BYPASS', '1');
    const database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    try {
      const subsystem = buildPermissionSubsystem(null, database.sqlite);
      expect(subsystem.permissionMode).toBe('default');

      const request: PermissionRequest = {
        tool: { id: 'bash', name: 'Bash' },
        input: { command: 'echo production' },
        intent: {
          riskLevel: 'high',
          accessType: 'execute',
          promptPolicy: 'whenRequired',
        },
        context: { mode: 'bypassPermissions' },
      };
      await expect(subsystem.permission.authorize(request)).resolves.toMatchObject({
        outcome: 'deny',
        reason: { type: 'mode', mode: 'bypassPermissions' },
      });
    } finally {
      database.close();
    }
  });
});
