// 测试 Subagent 工具的同步等待、显式后台、2 分钟自动转交、取消与按 id 读取.
import { describe, expect, it, vi } from 'vitest';
import type { SubagentControl, ToolInvocation } from '@ema-agent/tools';
import { SubagentTool } from '../tools/SubagentTool/SubagentTool.js';
import { SubagentAwaitTool } from '../tools/SubagentTool/SubagentAwaitTool.js';

const SUBAGENT_ID = 'subagent-1';

function makeInvocation(signal?: AbortSignal): ToolInvocation {
  return {
    sessionId: '00000000-0000-4000-8000-0000000000a1',
    turnId: '00000000-0000-4000-8000-0000000000a2',
    toolCallId: 'call-sub-1',
    signal: signal ?? new AbortController().signal,
  };
}

function makeSubagents(overrides: Partial<SubagentControl> = {}): SubagentControl {
  return {
    start: vi.fn(() => SUBAGENT_ID),
    waitForInitialResult: vi.fn(async () => null),
    moveToBackground: vi.fn(),
    awaitResult: vi.fn(async () => null),
    cancel: vi.fn(() => true),
    ...overrides,
  };
}

const INPUT = {
  prompt: '检查文件边界',
  description: '检查边界',
  role: undefined,
  providerId: undefined,
  modelId: undefined,
  contextMode: undefined,
  runInBackground: undefined,
};

describe('SubagentTool — 三形态', () => {
  it('runInBackground=true: 立即返回引用, 不等待', async () => {
    const subagents = makeSubagents();
    const projection = SubagentTool.validateContext({ subagents } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentTool.execute(
      { ...INPUT, runInBackground: true },
      projection.context,
      makeInvocation(),
    );

    expect(result).toEqual({
      kind: 'background',
      subagentId: SUBAGENT_ID,
      via: 'requested',
    });
    expect(subagents.start).toHaveBeenCalledWith(
      '检查文件边界',
      expect.objectContaining({ contextMode: 'subagent' }),
      'call-sub-1',
      true,
      expect.any(AbortSignal),
    );
  });

  it('同步路径在 2 分钟内完成: 返回 completed 结果', async () => {
    const subagents = makeSubagents({
      waitForInitialResult: vi.fn(async () => ({
        subagentId: SUBAGENT_ID,
        output: 'done',
        usage: { inputTokens: 1, outputTokens: 2 },
      })),
    });
    const projection = SubagentTool.validateContext({ subagents } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentTool.execute(INPUT, projection.context, makeInvocation());

    expect(result).toMatchObject({ kind: 'completed', output: 'done' });
    expect(subagents.start).toHaveBeenCalledWith(
      '检查文件边界', expect.any(Object), 'call-sub-1', false, expect.any(AbortSignal),
    );
  });

  it('同步等待超限自动转后台(via=auto), 不重新启动执行', async () => {
    vi.useFakeTimers();
    try {
      const subagents = makeSubagents({
        waitForInitialResult: vi.fn(() => new Promise(() => {})),
      });
      const projection = SubagentTool.validateContext({ subagents } as never);
      if (!projection.valid) throw new Error('投影应成功');

      const pending = SubagentTool.execute(INPUT, projection.context, makeInvocation());
      await vi.advanceTimersByTimeAsync(120_100);
      const result = await pending;

      expect(result.kind).toBe('background');
      expect(result.via).toBe('auto');
      expect(subagents.start).toHaveBeenCalledTimes(1);
      expect(subagents.moveToBackground).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同步等待被中止: 取消同一个 Subagent 后抛出', async () => {
    const controller = new AbortController();
    const subagents = makeSubagents({
      waitForInitialResult: vi.fn(() => new Promise(() => {})),
    });
    const projection = SubagentTool.validateContext({ subagents } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const pending = SubagentTool.execute(INPUT, projection.context, makeInvocation(controller.signal));
    controller.abort(new Error('用户中止'));

    await expect(pending).rejects.toThrow('用户中止');
    expect(subagents.cancel).toHaveBeenCalledTimes(1);
  });

  it('子 Agent 环境(无控制入口)投影失败: 深度限制 1', () => {
    expect(SubagentTool.validateContext({} as never).valid).toBe(false);
  });
});

describe('SubagentTool — 模型身份成对校验', () => {
  it('只给 modelId 不给 providerId 直接拒绝', async () => {
    const projection = SubagentTool.validateContext({ subagents: makeSubagents() } as never);
    if (!projection.valid) throw new Error('投影应成功');

    await expect(SubagentTool.execute(
      { ...INPUT, modelId: 'deepseek-chat' },
      projection.context,
      makeInvocation(),
    )).rejects.toThrow(/providerId/);
  });

  it('modelId+providerId 成对传递进执行入口', async () => {
    const subagents = makeSubagents();
    const projection = SubagentTool.validateContext({ subagents } as never);
    if (!projection.valid) throw new Error('投影应成功');

    await SubagentTool.execute(
      { ...INPUT, runInBackground: true, modelId: 'deepseek-chat', providerId: 'deepseek' },
      projection.context,
      makeInvocation(),
    );

    expect(subagents.start).toHaveBeenCalledWith(
      '检查文件边界',
      expect.objectContaining({ providerId: 'deepseek', modelId: 'deepseek-chat' }),
      'call-sub-1',
      true,
      expect.any(AbortSignal),
    );
  });
});

describe('SubagentAwait', () => {
  it('接受 Provider 产生的非 UUID ToolCall ID', () => {
    expect(SubagentAwaitTool.inputSchema.safeParse({ subagentId: SUBAGENT_ID }).success).toBe(true);
  });

  it('Await 返回输出; 未知或仍被其他等待方持有时返回 output:null', async () => {
    const subagents = makeSubagents();
    const projection = SubagentAwaitTool.validateContext({ subagents } as never);
    if (!projection.valid) throw new Error('投影应成功');

    const result = await SubagentAwaitTool.execute(
      { subagentId: SUBAGENT_ID }, projection.context, makeInvocation(),
    );

    expect(result).toEqual({ output: null });
    expect(subagents.awaitResult).toHaveBeenCalledWith(SUBAGENT_ID, expect.any(AbortSignal));
    expect(SubagentAwaitTool.mapResultToModelContent!(result)).toContain('No result available');
  });
});
