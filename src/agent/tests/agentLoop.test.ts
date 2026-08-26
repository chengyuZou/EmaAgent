// 验证 AgentLoop 的调用准备、输出恢复（升级/续写）、空转软引导与工具持久化握手。

import { describe, expect, it, vi } from 'vitest';
import type { CallLlm, LlmRequest, LlmTokenUsage, Message } from '@ema-agent/llm';
import { ContextWindowExceededError } from '@ema-agent/llm';
import type { StreamingToolExecutor, ToolResult } from '@ema-agent/tools';
import { runAgentLoop } from '../agentLoop.js';
import type { AgentLoopEvent } from '../events.js';
import type { AgentBudget, AgentLoopInput, PrepareAgentIterationInput } from '../types.js';

class TestBudget implements AgentBudget {
  readonly recorded: LlmTokenUsage[] = [];
  toolCalls = 0;

  assertWithinLimits(): void {}
  remainingOutputTokens(): number { return 64; }
  recordUsage(usage: LlmTokenUsage): void { this.recorded.push(usage); }
  reserveToolCall(): void { this.toolCalls += 1; }
  enterSubagent(): () => void { return () => undefined; }
}

function model(
  stream: CallLlm,
): CallLlm {
  return stream;
}

function idleExecutor(): StreamingToolExecutor {
  return {
    addTool: vi.fn(),
    start: vi.fn(),
    allDone: () => true,
    hasWaitingUserTool: () => false,
    takeCompletedResults: () => [],
    acknowledgeResult: vi.fn(),
  } as unknown as StreamingToolExecutor;
}

/** 单个工具：start 后第一次取结果时交付，随后枯竭。 */
function oneShotExecutor(result: ToolResult): StreamingToolExecutor {
  let started = false;
  let delivered = false;
  return {
    addTool: vi.fn(),
    start: vi.fn(() => { started = true; }),
    allDone: () => started,
    hasWaitingUserTool: () => false,
    takeCompletedResults: () => {
      if (!started || delivered) return [];
      delivered = true;
      return [result];
    },
    acknowledgeResult: vi.fn(),
  } as unknown as StreamingToolExecutor;
}

function baseInput(overrides: Partial<AgentLoopInput>): AgentLoopInput {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    prepareIteration: async ({ messages }) => ({
      request: { messages },
      messages,
    }),
    callLlm: model(() => (async function* () {
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'done' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })()),
    createToolExecutor: () => idleExecutor(),
    budget: new TestBudget(),
    signal: new AbortController().signal,
    maxIterations: 4,
    generationSource: { providerId: 'test-provider', modelId: 'test-model', protocol: 'openai-llm' },
    ...overrides,
  };
}

async function collect(
  input: AgentLoopInput,
  inspect?: (event: AgentLoopEvent) => void,
): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = [];
  for await (const event of runAgentLoop(input)) {
    events.push(event);
    inspect?.(event);
  }
  return events;
}

function terminalEvent(events: readonly AgentLoopEvent[]) {
  return events.find(
    (event): event is Extract<AgentLoopEvent, { type: 'loop_stopped' }> =>
      event.type === 'loop_stopped',
  );
}

describe('runAgentLoop', () => {
  it('每次迭代都经 prepareIteration，并按预算裁剪输出上限与累计 Usage 差值', async () => {
    const budget = new TestBudget();
    const stream = vi.fn((_request: LlmRequest) => (async function* () {
      yield { type: 'usage' as const, inputTokens: 10, outputTokens: 0 };
      yield { type: 'usage' as const, inputTokens: 10, outputTokens: 4 };
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'ok' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => ({
      request: {
        messages: [...messages],
        maxOutputTokens: 100,
      },
      messages,
    }));

    const result = await collect(baseInput({
      budget,
      prepareIteration,
      callLlm: model(stream),
    }));

    expect(prepareIteration).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 64 }));
    expect(budget.recorded).toEqual([
      { inputTokens: 10, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 4 },
    ]);
    const callUsage = result.filter(
      (event): event is Extract<AgentLoopEvent, { type: 'llm_call_usage_updated' }> =>
        event.type === 'llm_call_usage_updated',
    );
    expect(callUsage).toHaveLength(2);
    expect(callUsage[0]!.llmCallId).toBe(callUsage[1]!.llmCallId);
    expect(callUsage[1]!.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(result.filter(event => event.type === 'agent_usage_updated').at(-1)).toEqual({
      type: 'agent_usage_updated',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(result.find(event => event.type === 'llm_call_finished')).toEqual(
      expect.objectContaining({
        type: 'llm_call_finished',
        llmCallId: callUsage[0]!.llmCallId,
        status: 'completed',
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );
    expect(terminalEvent(result)?.finalText).toBe('ok');
  });

  it('Provider 报上下文超限时以同一 iteration 报告恢复原因', async () => {
    let attempt = 0;
    const stream = vi.fn(() => (async function* () {
      attempt += 1;
      if (attempt === 1) throw new ContextWindowExceededError();
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());
    const recoveryReasons: Array<string | undefined> = [];
    const callIds: string[] = [];
    const prepareIteration: AgentLoopInput['prepareIteration'] = vi.fn(async (input) => {
      recoveryReasons.push(input.recoveryReason);
      callIds.push(input.llmCallId);
      return {
        request: { messages: input.messages },
        messages: input.recoveryReason === 'context_window_exceeded'
          ? [{ role: 'user' as const, content: 'compacted history' }]
          : input.messages,
      };
    });

    await collect(baseInput({ prepareIteration, callLlm: model(stream) }));

    expect(recoveryReasons).toEqual([undefined, 'context_window_exceeded']);
    expect(callIds[0]).not.toBe(callIds[1]);
  });

  it('取消前已经收到的 Provider Usage 仍进入调用终态', async () => {
    const controller = new AbortController();
    const stream: CallLlm = () => (async function* () {
      yield { type: 'usage' as const, inputTokens: 12, outputTokens: 3 };
      controller.abort();
      throw new Error('cancelled by user');
    })();

    const events = await collect(baseInput({
      callLlm: stream,
      signal: controller.signal,
    }));

    expect(events.find(event => event.type === 'llm_call_finished')).toEqual(
      expect.objectContaining({
        type: 'llm_call_finished',
        status: 'cancelled',
        usage: { inputTokens: 12, outputTokens: 3 },
      }),
    );
    expect(terminalEvent(events)?.state.stopReason).toBe('aborted');
  });

  it('消费方恢复事件流后才启动工具，并在 ToolResult 落库边界后才 acknowledge', async () => {
    let llmCall = 0;
    let started = false;
    let acknowledged = false;
    let delivered = false;
    const result: ToolResult = {
      type: 'tool_result',
      toolCallId: 'call-1',
      content: 'read result',
      data: { uiOnly: true },
    };
    const executor = {
      addTool: vi.fn(),
      start: vi.fn(() => { started = true; }),
      allDone: () => started,
      hasWaitingUserTool: () => false,
      takeCompletedResults: () => {
        if (!started || delivered) return [];
        delivered = true;
        return [result];
      },
      acknowledgeResult: vi.fn(() => { acknowledged = true; }),
    } as unknown as StreamingToolExecutor;
    const stream = vi.fn(() => (async function* () {
      llmCall += 1;
      if (llmCall === 1) {
        yield {
          type: 'tool_use_complete' as const,
          blockIndex: 0,
          callId: 'call-1',
          name: 'Read',
          args: { path: 'a.ts' },
        };
        yield { type: 'done' as const, stopReason: 'tool_use' as const };
        return;
      }
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'finished' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());

    const observations: Array<[string, boolean, boolean]> = [];
    const collected = await collect(baseInput({
      callLlm: model(stream),
      createToolExecutor: () => llmCall === 0 ? executor : idleExecutor(),
    }), event => observations.push([event.type, started, acknowledged]));

    expect(observations.find(([type]) => type === 'tool_use_completed')).toEqual([
      'tool_use_completed', false, false,
    ]);
    expect(observations.find(([type]) => type === 'assistant_message_completed')).toEqual([
      'assistant_message_completed', false, false,
    ]);
    expect(observations.find(([type]) => type === 'tool_result')).toEqual([
      'tool_result', true, false,
    ]);
    expect(acknowledged).toBe(true);
    expect(terminalEvent(collected)?.finalText).toBe('finished');
  });

  it('max_tokens 首次触发升级重试：顶到预算上限、不注入续写、半截作废', async () => {
    const seen: LlmRequest[] = [];
    const seenMessages: Message[][] = [];
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => {
      seenMessages.push([...messages]);
      return {
        request: { messages: [...messages], maxOutputTokens: 8 },
        messages,
      };
    });
    let llmCall = 0;
    const stream = vi.fn((request: LlmRequest) => {
      seen.push(request);
      return (async function* () {
        llmCall += 1;
        if (llmCall === 1) {
          yield { type: 'text_delta' as const, blockIndex: 0, delta: '前半' };
          yield { type: 'done' as const, stopReason: 'max_tokens' as const };
          return;
        }
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '完整答案' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
    });

    const events = await collect(baseInput({ prepareIteration, callLlm: model(stream) }));

    expect(seen[0]!.maxOutputTokens).toBe(8);
    expect(seen[1]!.maxOutputTokens).toBe(64);
    expect(seenMessages[1]!.some((message) => (
      typeof message.content === 'string' && message.content.includes('继续输出剩余内容')
    ))).toBe(false);
    expect(events).toContainEqual({
      type: 'assistant_message_discarded',
      reason: 'max_tokens_retry',
    });
    expect(terminalEvent(events)?.finalText).toBe('完整答案');
  });

  it('升级后仍截断则注入续写提示并拼接 finalText', async () => {
    const seenMessages: Message[][] = [];
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => {
      seenMessages.push([...messages]);
      return { request: { messages: [...messages] }, messages };
    });
    let llmCall = 0;
    const stream = vi.fn(() => (async function* () {
      llmCall += 1;
      if (llmCall === 1) {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '作废' };
        yield { type: 'done' as const, stopReason: 'max_tokens' as const };
        return;
      }
      if (llmCall === 2) {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '新前半' };
        yield { type: 'done' as const, stopReason: 'max_tokens' as const };
        return;
      }
      yield { type: 'text_delta' as const, blockIndex: 0, delta: '尾' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());

    const events = await collect(baseInput({ prepareIteration, callLlm: model(stream) }));

    const thirdIteration = seenMessages[2]!;
    expect(thirdIteration.some((message) => (
      typeof message.content === 'string' && message.content.includes('继续输出剩余内容')
    ))).toBe(true);
    expect(terminalEvent(events)?.finalText).toBe('新前半尾');
  });

  it('升级与续写都失败判 output_recovery_failed 并保留已拼接文本', async () => {
    const stream = vi.fn(() => (async function* () {
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'x' };
      yield { type: 'done' as const, stopReason: 'max_tokens' as const };
    })());

    const events = await collect(baseInput({ callLlm: model(stream) }));

    expect(terminalEvent(events)?.state.stopReason).toBe('output_recovery_failed');
    expect(terminalEvent(events)?.finalText).toBe('xx');
  });

  it('Tool Loop 保留 thinking（含原生状态）并挂载生成来源供下一轮重放裁决', async () => {
    const seenMessages: Message[][] = [];
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => {
      seenMessages.push([...messages]);
      return { request: { messages: [...messages] }, messages };
    });
    let llmCall = 0;
    const stream = vi.fn(() => (async function* () {
      llmCall += 1;
      if (llmCall === 1) {
        yield {
          type: 'thinking_delta' as const,
          blockIndex: 0,
          delta: '推理过程',
        };
        yield {
          type: 'thinking_complete' as const,
          blockIndex: 0,
          state: { kind: 'anthropic' as const, signature: 'sig-1' },
        };
        yield {
          type: 'tool_use_complete' as const,
          blockIndex: 1,
          callId: 'call-1',
          name: 'Read',
          args: { path: 'a.ts' },
        };
        yield { type: 'done' as const, stopReason: 'tool_use' as const };
        return;
      }
      yield { type: 'text_delta' as const, blockIndex: 0, delta: '完成' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());
    const toolResult: ToolResult = {
      type: 'tool_result',
      toolCallId: 'call-1',
      content: 'read result',
    };

    await collect(baseInput({
      prepareIteration,
      callLlm: model(stream),
      createToolExecutor: () => oneShotExecutor(toolResult),
      generationSource: {
        providerId: 'test-provider',
        modelId: 'claude-test',
        protocol: 'anthropic-llm',
      },
    }));

    const secondIteration = seenMessages[1]!;
    const assistant = secondIteration.find(message => message.role === 'assistant');
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '推理过程', signature: 'sig-1' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.ts' } },
      ],
      generatedBy: {
        providerId: 'test-provider',
        modelId: 'claude-test',
        protocol: 'anthropic-llm',
      },
    });
  });

  it('Tool Loop 保留没有摘要文本的 OpenAI reasoning 状态', async () => {
    const seenMessages: Message[][] = [];
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => {
      seenMessages.push([...messages]);
      return { request: { messages: [...messages] }, messages };
    });
    let llmCall = 0;
    const stream = vi.fn(() => (async function* () {
      llmCall += 1;
      if (llmCall === 1) {
        yield {
          type: 'thinking_complete' as const,
          blockIndex: 0,
          state: { kind: 'openai' as const, id: 'rsn-1', encryptedContent: 'encrypted-1' },
        };
        yield {
          type: 'tool_use_complete' as const,
          blockIndex: 1,
          callId: 'call-1',
          name: 'Read',
          args: { path: 'a.ts' },
        };
        yield { type: 'done' as const, stopReason: 'tool_use' as const };
        return;
      }
      yield { type: 'text_delta' as const, blockIndex: 0, delta: '完成' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })());

    await collect(baseInput({
      prepareIteration,
      callLlm: model(stream),
      createToolExecutor: () => oneShotExecutor({
        type: 'tool_result',
        toolCallId: 'call-1',
        content: 'read result',
      }),
      generationSource: {
        providerId: 'test-provider',
        modelId: 'gpt-test',
        protocol: 'openai-responses-llm',
      },
    }));

    const assistant = seenMessages[1]!.find(message => message.role === 'assistant');
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', id: 'rsn-1', encryptedContent: 'encrypted-1' },
        { type: 'tool_use', id: 'call-1', name: 'Read', args: { path: 'a.ts' } },
      ],
    });
  });

  it('连续三轮完全相同的工具批次注入一次空转软引导', async () => {
    const seenMessages: Message[][] = [];
    const prepareIteration = vi.fn(async ({ messages }: PrepareAgentIterationInput) => {
      seenMessages.push([...messages]);
      return { request: { messages: [...messages] }, messages };
    });
    const stream = vi.fn(() => (async function* () {
      yield {
        type: 'tool_use_complete' as const,
        blockIndex: 0,
        callId: 'call-1',
        name: 'Read',
        args: { path: 'a.ts' },
      };
      yield { type: 'done' as const, stopReason: 'tool_use' as const };
    })());
    const toolResult: ToolResult = {
      type: 'tool_result',
      toolCallId: 'call-1',
      content: 'same result',
    };

    const events = await collect(baseInput({
      prepareIteration,
      callLlm: model(stream),
      createToolExecutor: () => oneShotExecutor(toolResult),
      maxIterations: 6,
    }));

    const fourthIteration = seenMessages[3]!;
    expect(fourthIteration.some((message) => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('已连续多轮以完全相同的参数')
    ))).toBe(true);
    // 软引导只注入一次：最终工作历史里恰好一条。
    const finalHistory = seenMessages.at(-1)!;
    expect(finalHistory.filter((message) => (
      typeof message.content === 'string' && message.content.includes('已连续多轮以完全相同的参数')
    ))).toHaveLength(1);
    expect(terminalEvent(events)?.state.stopReason).toBe('max_iterations');
  });
});
