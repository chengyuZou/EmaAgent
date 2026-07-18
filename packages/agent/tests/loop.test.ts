// 测试 Agent 循环的终止保护、LLM 调用标识和工具上下文预算接线。
import { describe, expect, it, vi } from 'vitest';
import type { LlmCallId, LlmMessage } from '@ema-agent/contracts';
import type { AgentPolicy } from '../src/policy.js';
import type { TurnToolExecutor } from '../src/tool-executor.js';
import { agentLoop } from '../src/loop.js';
import { TurnBudget } from '../src/turn-budget.js';

function makePolicy(): AgentPolicy {
  return {
    toolDefs: () => [],
  } as unknown as AgentPolicy;
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

describe('agentLoop LLM 生命周期', () => {
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
    const compactMessages = vi.fn(async (messages: LlmMessage[]) => messages);
    const stream = vi.fn(() => (async function* () {
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());

    for await (const event of agentLoop({
      messages: [{ role: 'user', content: 'read it' }],
      policy: { toolDefs: () => tools } as unknown as AgentPolicy,
      buildExecutor: () => makeExecutor(),
      llm: { stream } as never,
      providerId: 'provider-1',
      model: 'model-1',
      signal: new AbortController().signal,
      maxIterations: 1,
      budget: new TurnBudget(),
      sessionId: 'session-1',
      compactMessages,
    })) {
      expect(event.type).toBeDefined();
    }

    expect(compactMessages).toHaveBeenCalledWith(
      [{ role: 'user', content: 'read it' }],
      tools,
    );
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
    const events = [];

    for await (const event of agentLoop({
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
    })) {
      events.push(event);
    }

    expect(stream).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual({
      type: 'loop_breaker',
      reason: 'permission denied 3 consecutive times',
    });
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'loop_done',
      state: expect.objectContaining({ transition: 'permission_denial_loop' }),
    }));
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
      messages: LlmMessage[];
    }> = [];
    const completed: Array<{
      iteration: number;
      llmCallId: LlmCallId;
      cacheReadInputTokens?: number;
      cacheHitRate?: number;
      promptPrefixHash: string | null;
    }> = [];
    const eventTypes: string[] = [];

    for await (const event of agentLoop({
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
    })) {
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
    expect(eventTypes.at(-1)).toBe('loop_done');
  });
});
