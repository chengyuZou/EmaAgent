// 验证 AgentLoop 的调用准备、响应式压缩与工具持久化握手。

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel, LlmRequest, LlmTokenUsage, Message } from '@ema-agent/llm';
import { ContextWindowExceededError } from '@ema-agent/llm';
import type { StreamingToolExecutor, ToolResult } from '@ema-agent/tools';
import { runAgentLoop } from '../agentLoop.js';
import type { AgentLoopEvent } from '../events.js';
import type { AgentBudget, AgentLoopInput } from '../types.js';

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
  stream: LanguageModel['stream'],
): LanguageModel {
  return {
    protocol: 'openai-llm',
    stream,
    complete: vi.fn(),
  } as unknown as LanguageModel;
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

function baseInput(overrides: Partial<AgentLoopInput>): AgentLoopInput {
  const messages: readonly Message[] = [{ role: 'user', content: 'hello' }];
  return {
    history: [],
    currentMessages: messages,
    prepareIteration: async ({ currentMessages }) => ({
      request: { model: 'test', messages: currentMessages },
      history: [],
    }),
    llm: model(() => (async function* () {
      yield { type: 'text_delta' as const, blockIndex: 0, delta: 'done' };
      yield { type: 'done' as const, stopReason: 'end_turn' as const };
    })()),
    createToolExecutor: () => idleExecutor(),
    budget: new TestBudget(),
    signal: new AbortController().signal,
    maxIterations: 4,
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
    const prepareIteration = vi.fn(async () => ({
      request: {
        model: 'test',
        messages: [{ role: 'user' as const, content: 'hello' }],
        maxOutputTokens: 100,
      },
      history: [],
    }));

    const result = await collect(baseInput({
      budget,
      prepareIteration,
      llm: model(stream),
    }));

    expect(prepareIteration).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 64 }));
    expect(budget.recorded).toEqual([
      { inputTokens: 10, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 4 },
    ]);
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
    const prepareIteration: AgentLoopInput['prepareIteration'] = vi.fn(async (input) => {
      recoveryReasons.push(input.recoveryReason);
      return {
        request: { model: 'test', messages: input.currentMessages },
        history: input.recoveryReason === 'context_window_exceeded'
          ? [{ role: 'user', content: 'compacted history' }]
          : input.history,
      };
    });

    await collect(baseInput({ prepareIteration, llm: model(stream) }));

    expect(recoveryReasons).toEqual([undefined, 'context_window_exceeded']);
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
      llm: model(stream),
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
});
