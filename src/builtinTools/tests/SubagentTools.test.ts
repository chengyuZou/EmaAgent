// 测试子 Agent 工具默认使用独立上下文，并能按 AgentRunId 发送、等待和取消后台执行。
import { describe, expect, it, vi } from 'vitest';
import { asAgentRunId } from '@ema-agent/ids';
import {
  SubagentAbortTool,
  SubagentAwaitTool,
  SubagentSendMessageTool,
  SubagentTool,
} from '../index.js';

const agentRunId = asAgentRunId('11111111-1111-4111-8111-111111111111');

describe('Subagent 工具契约', () => {
  it('同步启动默认使用 fresh 子 Agent，而不是隐式继承父历史', async () => {
    const spawn = vi.fn(async () => ({
      agentRunId,
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
    }));

    await SubagentTool.execute(
      {
        prompt: '检查文件边界',
        description: '检查边界',
        kind: undefined,
        model: undefined,
        taskId: undefined,
      },
      {
        spawner: { spawn },
        signal: new AbortController().signal,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      '检查文件边界',
      expect.objectContaining({ kind: 'subagent' }),
      expect.any(AbortSignal),
    );
  });

  it('后台控制工具使用同一个 AgentRunId，不把它当 TurnId', async () => {
    const queueMessage = vi.fn(() => true);
    const awaitBackground = vi.fn(async () => ({
      agentRunId,
      output: 'done',
      usage: { inputTokens: 2, outputTokens: 3 },
    }));
    const abortSubagent = vi.fn(() => true);
    const context = {
      spawner: {
        spawn: vi.fn(),
        queueMessage,
        awaitBackground,
        abortSubagent,
      },
      signal: new AbortController().signal,
    };

    await expect(SubagentSendMessageTool.execute(
      { agentRunId, message: '停止扩展范围' },
      context,
    )).resolves.toEqual({ queued: true });
    await expect(SubagentAwaitTool.execute(
      { agentRunId },
      context,
    )).resolves.toEqual({
      agentRunId,
      output: 'done',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    await expect(SubagentAbortTool.execute(
      { agentRunId },
      context,
    )).resolves.toEqual({ aborted: true });

    expect(queueMessage).toHaveBeenCalledWith(agentRunId, '停止扩展范围');
    expect(awaitBackground).toHaveBeenCalledWith(agentRunId);
    expect(abortSubagent).toHaveBeenCalledWith(agentRunId);
  });
});
