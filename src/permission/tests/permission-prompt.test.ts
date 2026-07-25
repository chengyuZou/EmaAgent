// 测试 Permission Engine 询问用户时完整保留工具说明和可信风险字段。
import { describe, expect, it, vi } from 'vitest';
import { PermissionEngine } from '../permissionEngine.js';
import { InMemoryPermissionRuleStore } from '../policy/permissionRuleStore.js';
import type { AskPermissionFn } from '../types.js';

describe('PermissionPrompt 展示字段', () => {
  it('把 Tool 身份中的说明与权限元数据交给询问回调', async () => {
    const ask = vi.fn<AskPermissionFn>(async () => ({ action: 'deny' }));
    const engine = new PermissionEngine({ mode: 'ask', ask }, new InMemoryPermissionRuleStore());

    await engine.gate(
      { id: 'file_edit', name: 'FileEdit', description: '编辑指定文件的内容' },
      { path: 'D:/workspace/readme.md' },
      { riskLevel: 'medium', accessType: 'write' },
      {
        workspaceRoot: 'D:/workspace',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
      },
    );

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'file_edit',
      toolName: 'FileEdit',
      toolDescription: '编辑指定文件的内容',
      riskLevel: 'medium',
      accessType: 'write',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
    }));
  });
});
