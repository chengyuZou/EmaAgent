// 测试窗口重开后按 Session 恢复 Core 仍在等待的权限请求。
import { beforeEach, describe, expect, it } from 'vitest';
import type { PendingPermissionPrompt } from '@ema-agent/permission';

import { useDecisionStore } from '../src/stores/decision-store.js';

describe('permission prompt recovery', () => {
  beforeEach(() => useDecisionStore.getState().clear());

  it('恢复到对应 Session 队列并按 promptId 去重', () => {
    const pending: PendingPermissionPrompt = {
      promptId: 'prompt-1',
      createdAt: 1,
      prompt: {
        toolId: 'file_edit',
        toolName: 'FileEdit',
        toolDescription: '编辑 README 文件',
        input: { path: 'D:/workspace/README.md' },
        riskLevel: 'medium',
        accessType: 'write',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
      },
    };

    useDecisionStore.getState().restorePermissions([pending, pending]);

    const queue = useDecisionStore.getState().sessions.get('session-1');
    expect(queue).toHaveLength(1);
    expect(queue?.[0]).toEqual(expect.objectContaining({
      kind: 'permission',
      promptId: 'prompt-1',
      turnId: 'turn-1',
      toolDescription: '编辑 README 文件',
      riskLevel: 'medium',
    }));
  });

  it('恢复 Ask User 变体并保留 Session 与 Turn 身份', () => {
    useDecisionStore.getState().restoreAskUser([{
      createdAt: 2,
      request: {
        type: 'ask_text_required',
        sessionId: 'session-2',
        turnId: 'turn-2',
        promptId: 'prompt-2',
        question: '请输入名称',
        placeholder: '名称',
      },
    }]);

    expect(useDecisionStore.getState().sessions.get('session-2')?.[0]).toEqual(
      expect.objectContaining({
        kind: 'ask_text',
        turnId: 'turn-2',
        promptId: 'prompt-2',
        question: '请输入名称',
      }),
    );
  });
});
