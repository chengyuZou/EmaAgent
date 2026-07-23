// 测试 Core 把权限提示完整转换为结构化 SSE，避免展示字段在接线层丢失。
import { describe, expect, it } from 'vitest';
import type { ToolCallId, TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/events';
import type { PermissionPrompt } from '@ema-agent/permission';
import type { SettingsRepo } from '@ema-agent/storage';
import { buildPermissionSubsystem } from '../src/wiring/permission-bootstrap.js';

describe('permission_required SSE', () => {
  it('保留 Tool 说明、风险等级、访问类型和门禁原因', async () => {
    const settingsRepo = {
      get: () => undefined,
    } as unknown as SettingsRepo;
    const subsystem = buildPermissionSubsystem(settingsRepo);
    const events: EmaStreamEvent[] = [];
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
      gateReason: '需要修改工作区文件',
    };

    const responsePromise = ask(prompt);
    const required = events[0];
    expect(required).toEqual(expect.objectContaining({
      type: 'permission_required',
      toolId: 'file_edit',
      tool: 'FileEdit',
      toolDescription: '编辑指定文件的内容',
      riskLevel: 'medium',
      accessType: 'write',
      gateReason: '需要修改工作区文件',
      hint: '需要修改工作区文件',
    }));
    if (!required || required.type !== 'permission_required') {
      throw new Error('permission_required event was not emitted');
    }

    subsystem.permissionPrompts.respond(required.promptId, { action: 'allow' });
    await expect(responsePromise).resolves.toEqual({ action: 'allow' });
    expect(events[1]).toEqual(expect.objectContaining({
      type: 'permission_resolved',
      promptId: required.promptId,
      decision: 'allow',
    }));
  });
});
