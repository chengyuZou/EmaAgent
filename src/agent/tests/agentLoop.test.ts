// 测试 Agent 循环的终止保护、LLM 调用标识和工具上下文预算接线。
import { describe, expect, it, vi } from 'vitest';
import { ContextWindowExceededError } from '@ema-agent/llm';
import type { LlmCallId, Message as ModelMessage } from '@ema-agent/llm';
import type { ModelContextSnapshot } from '@ema-agent/context';
import type { TurnPolicy } from '../policy.js';
import type { TurnToolExecutor } from '../tool-executor.js';
import {
  runAgentLoop,
  type AgentLoopEvent,
  type AgentLoopOutcome,
} from '../agentLoop.js';
import { TurnBudget } from '../turn-budget.js';

function makePolicy(): TurnPolicy {
  return {
    toolDefs: () => [],
  } as unknown as TurnPolicy;
}

function makeExecutor(): TurnToolExecutor {
  return {
    reset: () => undefined,
    addTool: () => undefined,
    allDone: () => true,
    hasWaitingUserTool: () => false,
    getResults: () => [],
  } as unknown as TurnToolExecutor;
}

async function collectAgentLoop(
  loop: AsyncGenerator<AgentLoopEvent<never>, AgentLoopOutcome>,
): Promise<{ events: Array<AgentLoopEvent<never>>; outcome: AgentLoopOutcome }> {
  const events: Array<AgentLoopEvent<never>> = [];
  let step = await loop.next();
  while (!step.done) {
    events.push(step.value);
    step = await loop.next();
  }
  return { events, outcome: step.value };
}

describe('AgentLoop LLM 生命周期', () => {
  it('累计 Usage 快照只按差值计入 Turn，不重复计算输入 Token', async () => {
    const stream = vi.fn(() => (async function* () {
      yield { type: 'usage' as const, inputTokens: 100, outputTokens: 0 };
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'done' };
      yield { type: 'usage' as const, inputTokens: 100, outputTokens: 20 };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());
    const usageSnapshots: Array<{ inputTokens: number; outputTokens: number }> = [];
    const result = await collectAgentLoop(runAgentLoop<never>({
      messages: [{ role: 'user', content: 'hello' }],
      policy: makePolicy(),
      buildExecutor: () => makeExecutor(),
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 1,
      budget: new TurnBudget({
        maxWallTimeMs: 60_000,
        maxInputTokens: 150,
        maxOutputTokens: 30,
        maxToolCalls: 1,
        maxSubagents: 1,
        maxConcurrentSubagents: 1,
      }),
      sessionId: 'session-1',
    }));
    for (const event of result.events) {
      if (event.type === 'loop_usage') usageSnapshots.push(event.usage);
    }

    expect(usageSnapshots).toEqual([
      { inputTokens: 100, outputTokens: 0 },
      { inputTokens: 100, outputTokens: 20 },
    ]);
    expect(result.outcome.state.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('把本轮工具定义同时交给上下文压缩和 LLM 请求', async () => {
    const tools = [{
      name: 'Read',
      description: '读取文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }];
    const assembleContext = vi.fn(async ({
      history,
      currentTurn,
    }: {
      history: readonly ModelMessage[];
      currentTurn: readonly ModelMessage[];
    }): Promise<ModelContextSnapshot> => ({
      messages: [...history, ...currentTurn],
      history: [...history],
      tools,
      promptRevision: 'prompt-revision',
      toolManifestRevision: 'tool-revision',
      contextRevision: 'context-revision',
    }));
    const stream = vi.fn(() => (async function* () {
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());

    const result = await collectAgentLoop(runAgentLoop<never>({
      messages: [{ role: 'user', content: 'read it' }],
      policy: { toolDefs: () => tools } as unknown as TurnPolicy,
      buildExecutor: () => makeExecutor(),
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 1,
      budget: new TurnBudget(),
      sessionId: 'session-1',
      historyMessageCount: 0,
      assembleContext,
    }));
    for (const event of result.events) {
      expect(event.type).toBeDefined();
    }

    expect(assembleContext).toHaveBeenCalledWith(expect.objectContaining({
      history: [],
      currentTurn: [{ role: 'user', content: 'read it' }],
      forceCompaction: false,
    }));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ tools }));
  });

  it('连续三次权限拒绝后终止当前 Turn，避免模型无限重试', async () => {
    let call = 0;
    const stream = vi.fn(() => (async function* () {
      call++;
      yield {
        type: 'tool_use_complete' as const,
        callId: `call-${call}`,
        name: 'shell_command',
        args: { command: 'npm publish' },
        blockIndex: 0,
      };
      yield { type: 'done' as const, stopReason: 'tool_use' as const };
    })());
    const executor = {
      reset: () => undefined,
      addTool: () => undefined,
      allDone: () => true,
      hasWaitingUserTool: () => false,
      getResults: () => [{
        type: 'tool_result' as const,
        toolUseId: `call-${call}`,
        content: 'Permission denied: user denied',
        isError: true,
        errorCode: 'permission/denied',
      }],
    } as unknown as TurnToolExecutor;
    const result = await collectAgentLoop(runAgentLoop<never>({
      messages: [{ role: 'user', content: 'publish it' }],
      policy: makePolicy(),
      buildExecutor: () => executor,
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 10,
      budget: new TurnBudget(),
      sessionId: 'session-1',
    }));

    expect(stream).toHaveBeenCalledTimes(3);
    expect(result.events).toContainEqual({
      type: 'loop_breaker',
      reason: 'permission denied 3 consecutive times',
    });
    expect(result.outcome.state.transition).toBe('permission_denial_loop');
  });

  it('每个逻辑轮次配对 iteration + llmCallId，并限制 max_tokens 恢复次数', async () => {
    const stream = vi.fn(() => (async function* () {
      yield {
        type: 'usage' as const,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 75,
        cacheHitRate: 0.75,
      };
      yield { type: 'done' as const, stopReason: 'max_tokens' as const };
    })());

    const before: Array<{
      iteration: number;
      llmCallId: LlmCallId;
      messages: ModelMessage[];
    }> = [];
    const completed: Array<{
      iteration: number;
      llmCallId: LlmCallId;
      cacheReadInputTokens?: number;
      cacheHitRate?: number;
      promptPrefixHash: string | null;
    }> = [];
    const eventTypes: string[] = [];

    const result = await collectAgentLoop(runAgentLoop<never>({
      messages: [{ role: 'user', content: 'hello' }],
      policy: makePolicy(),
      buildExecutor: () => makeExecutor(),
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 10,
      budget: new TurnBudget(),
      sessionId: 'session-1',
      prepareLlmCall: async (call) => {
        before.push({
          iteration: call.iteration,
          llmCallId: call.llmCallId,
          messages: [...call.messages],
        });
        return {
          kind: 'continue',
          messages: [
            { role: 'system', content: 'stable', cacheBreakpoint: true },
            ...call.messages,
          ],
        };
      },
    }));
    for (const event of result.events) {
      eventTypes.push(event.type);
      if (event.type === 'loop_llm_complete') {
        completed.push({
          iteration: event.iteration,
          llmCallId: event.llmCallId,
          cacheReadInputTokens: event.usage.cacheReadInputTokens,
          cacheHitRate: event.usage.cacheHitRate,
          promptPrefixHash: event.promptPrefixHash,
        });
      }
    }

    expect(stream).toHaveBeenCalledTimes(2);
    expect(before.map((call) => call.iteration)).toEqual([1, 2]);
    expect(completed.map(({ iteration, llmCallId }) => ({ iteration, llmCallId })))
      .toEqual(before.map(({ iteration, llmCallId }) => ({ iteration, llmCallId })));
    expect(completed.map((call) => call.cacheReadInputTokens)).toEqual([75, 75]);
    expect(completed.map((call) => call.cacheHitRate)).toEqual([0.75, 0.75]);
    expect(completed[0]?.promptPrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed[1]?.promptPrefixHash).toBe(completed[0]?.promptPrefixHash);
    expect(new Set(before.map((call) => call.llmCallId)).size).toBe(2);
    expect(before[1]?.messages.some((message) => message.role === 'system')).toBe(false);
    expect(eventTypes).toContain('loop_breaker');
    expect(result.outcome.state.transition).toBe('max_output_tokens_recovery');
  });

  it('响应式压缩生成新快照后重新应用最终请求 Hook，并保持同一 llmCallId', async () => {
    let attempt = 0;
    const stream = vi.fn(() => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new ContextWindowExceededError();
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());
    const hookCallIds: LlmCallId[] = [];
    const assembleContext = vi.fn(async ({ forceCompaction }: { forceCompaction: boolean }) => ({
      messages: [{ role: 'user' as const, content: forceCompaction ? 'compacted' : 'original' }],
      history: [],
      tools: [],
      promptRevision: 'prompt-revision',
      toolManifestRevision: 'tool-revision',
      contextRevision: forceCompaction ? 'forced-revision' : 'initial-revision',
    }));

    await collectAgentLoop(runAgentLoop<never>({
      messages: [{ role: 'user', content: 'hello' }],
      historyMessageCount: 0,
      policy: makePolicy(),
      buildExecutor: () => makeExecutor(),
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 1,
      budget: new TurnBudget(),
      sessionId: 'session-1',
      assembleContext,
      prepareLlmCall: async (call) => {
        hookCallIds.push(call.llmCallId);
        return {
          kind: 'continue',
          messages: [{ role: 'system', content: 'hooked' }, ...call.messages],
        };
      },
    }));

    expect(assembleContext).toHaveBeenLastCalledWith(expect.objectContaining({
      forceCompaction: true,
    }));
    expect(hookCallIds).toHaveLength(2);
    expect(new Set(hookCallIds).size).toBe(1);
    expect(stream).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'hooked' },
        { role: 'user', content: 'compacted' },
      ],
    }));
  });
});
