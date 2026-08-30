// 验证 SubagentSpawner 只编排 AgentRun 生命周期与同一 AgentLoop。

import { describe, expect, it, vi } from 'vitest';
import type { CallLlm } from '@ema-agent/llm';
import type { StreamingToolExecutor } from '@ema-agent/tools';
import { SubagentSpawner } from '../subagentSpawner.js';
import type { AgentBudget, AgentLoopInput } from '../types.js';
import type { AgentRunStore } from '../runs/agentRunStore.js';
import type { AgentRunMessagesStore } from '../runs/agentRunMessagesStore.js';

const budget: AgentBudget = {
  enterSubagent: () => () => undefined,
};

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

describe('SubagentSpawner', () => {
  it('先记录 AgentRun 与 transcript，再发布事件，并把邮箱交给调用准备闭包', async () => {
    const order: string[] = [];
    const agentRunStore = {
      start: vi.fn(() => { order.push('run:start'); return {}; }),
      complete: vi.fn(() => {
        order.push('run:complete');
        return { ok: true, changed: true, run: {} };
      }),
      fail: vi.fn(() => ({ ok: true, changed: true, run: {} })),
      cancel: vi.fn(() => ({ ok: true, changed: true, run: {} })),
    } as unknown as AgentRunStore;
    const messagesStore = {
      record: vi.fn((_id, event) => { order.push(`transcript:${event.type}`); }),
      discard: vi.fn(),
    } as unknown as AgentRunMessagesStore;
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const prepareSubagent = vi.fn(async (input): Promise<AgentLoopInput> => {
      await preparationGate;
      const callLlm: CallLlm = () => (async function* () {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: 'answer' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
      return {
        messages: [{ role: 'user', content: input.prompt }],
        prepareIteration: async ({ messages }) => ({
          request: { messages },
          messages,
        }),
        callLlm,
        createToolExecutor: () => idleExecutor(),
        budget,
        signal: input.signal,
        maxIterations: 2,
        generationSource: {
          providerId: 'provider-1',
          modelId: 'model-1',
          protocol: 'openai-llm',
        },
      };
    });
    const events: string[] = [];
    const onLlmCallFinished = vi.fn();
    const spawner = new SubagentSpawner({
      parentSessionId: 'session-1',
      parentTurnId: 'turn-1',
      budget,
      prepareSubagent,
      agentRunStore,
      messagesStore,
      emit: (event) => {
        order.push(
          event.type === 'agent_run_event'
            ? `emit:${event.type}:${event.event.type}`
            : `emit:${event.type}`,
        );
        events.push(
          event.type === 'agent_run_event' ? event.event.type : event.type,
        );
      },
      onLlmCallFinished,
    });
    const agentRunId = 'run-1';

    spawner.spawnBackground(
      'inspect code',
      { agentRunId, kind: 'subagent' },
      new AbortController().signal,
    );
    releasePreparation();
    const result = await spawner.awaitBackground(agentRunId);

    expect(result?.output).toBe('answer');
    expect(order.indexOf('run:start')).toBeLessThan(order.indexOf('emit:agent_run_started'));
    expect(order.indexOf('transcript:text_delta')).toBeLessThan(
      order.indexOf('emit:agent_run_event:text_delta'),
    );
    expect(order.indexOf('run:complete')).toBeLessThan(
      order.indexOf('emit:agent_run_completed'),
    );
    expect(events).toEqual([
      'agent_run_started',
      'iteration_started',
      'text_delta',
      'llm_call_finished',
      'assistant_message_completed',
      'model_history_appended',
      'loop_stopped',
      'agent_run_completed',
    ]);
    expect(onLlmCallFinished).toHaveBeenCalledOnce();
    expect(onLlmCallFinished).toHaveBeenCalledWith(expect.objectContaining({
      type: 'llm_call_finished',
      status: 'completed',
      source: {
        providerId: 'provider-1',
        modelId: 'model-1',
        protocol: 'openai-llm',
      },
    }));
  });
});
