// Subagent 工具测试同步、后台、自动转交、取消与等待结果语义。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asToolCallId, asTurnId } from '@ema-agent/ids';
import type { ToolInvocation } from '@ema-agent/tools';
import { SubagentTool } from '../tools/SubagentTool/SubagentTool.js';
import { SubagentAwaitTool } from '../tools/SubagentTool/SubagentAwaitTool.js';

const AGENT_RUN_ID = '11111111-1111-4111-8111-111111111111';

function makeInvocation(signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: asSessionId('00000000-0000-4000-8000-0000000000a1'),
    turnId: asTurnId('00000000-0000-4000-8000-0000000000a2'),
    toolCallId: asToolCallId('call-sub-1'),
    signal: signal ?? new AbortController().signal,
  };
}

const INPUT = {
  prompt: '检查文件边界',
  description: '检查边界',
  kind: undefined,
  model: undefined,
  taskId: undefined,
  runInBackground: undefined,
};

describe('SubagentTool — 三形态', () => {
  it('runInBackground=true: 立即返回引用, 不等待', async () => {
    const spawnBackground = vi.fn();
    const projection = SubagentTool.validateContext({
      subagentSpawner: { spawn: vi.fn(), spawnBackground },
    } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentTool.execute(
      { ...INPUT, runInBackground: true },
      projection.context,
      makeInvocation(),
    );

    expect(result.kind).toBe('background');
    expect(result.via).toBe('requested');
    expect(spawnBackground).toHaveBeenCalledWith(
      '检查文件边界',
      expect.objectContaining({ kind: 'subagent' }),
      expect.any(AbortSignal),
    );
  });

  it('同步路径在 30s 内完成: 返回 completed 结果', async () => {
    const spawnBackground = vi.fn();
    const awaitBackground = vi.fn(async () => ({
      agentRunId: AGENT_RUN_ID,
      output: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const projection = SubagentTool.validateContext({
      subagentSpawner: { spawn: vi.fn(), spawnBackground, awaitBackground },
    } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentTool.execute(INPUT, projection.context, makeInvocation());

    expect(result).toMatchObject({ kind: 'completed', output: 'done' });
  });

  it('同步等待超限自动转后台(via=auto), 不阻塞到天荒地老', async () => {
    vi.useFakeTimers();
    try {
      const spawnBackground = vi.fn();
      // awaitBackground 永不结算,模拟长跑。
      const awaitBackground = vi.fn(() => new Promise(() => {}));
      const projection = SubagentTool.validateContext({
        subagentSpawner: { spawn: vi.fn(), spawnBackground, awaitBackground },
      } as never);
      if (!projection.valid) throw new Error('投影应成功');

      const pending = SubagentTool.execute(INPUT, projection.context, makeInvocation());
      await vi.advanceTimersByTimeAsync(30_100);
      const result = await pending;

      expect(result.kind).toBe('background');
      expect(result.via).toBe('auto');
    } finally {
      vi.useRealTimers();
    }
  });

  it('同步等待被中止: 取消子 Agent 后抛出, 不留孤儿', async () => {
    const controller = new AbortController();
    const abortSubagent = vi.fn();
    const awaitBackground = vi.fn(() => new Promise(() => {}));
    const projection = SubagentTool.validateContext({
      subagentSpawner: {
        spawn: vi.fn(),
        spawnBackground: vi.fn(),
        awaitBackground,
        abortSubagent,
      },
    } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const pending = SubagentTool.execute(INPUT, projection.context, makeInvocation(controller.signal));
    controller.abort(new Error('用户中止'));

    await expect(pending).rejects.toThrow('用户中止');
    expect(abortSubagent).toHaveBeenCalledTimes(1);
  });

  it('子 Agent 环境(无 spawner)投影失败: 深度限制 1', () => {
    expect(SubagentTool.validateContext({} as never).valid).toBe(false);
  });
});

describe('SubagentAwait', () => {
  it('Await 返回输出; 未知 id 返回 output:null 并如实投影', async () => {
    const awaitBackground = vi.fn(async () => null);
    const projection = SubagentAwaitTool.validateContext({
      subagentSpawner: { spawn: vi.fn(), awaitBackground },
    } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentAwaitTool.execute({ agentRunId: AGENT_RUN_ID }, projection.context);

    expect(result).toEqual({ output: null });
    expect(SubagentAwaitTool.mapResultToModelContent!(result)).toContain('No result available');
  });
});
