// 验证 SubagentSpawner 只编排 AgentRun 生命周期与同一 AgentLoop。

import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@ema-agent/llm';
import type { StreamingToolExecutor } from '@ema-agent/tools';
import { SubagentSpawner } from '../subagentSpawner.js';
import type { AgentBudget, AgentLoopInput } from '../types.js';
import type { AgentRunStore } from '../runs/agentRunStore.js';
import type { AgentRunTranscript } from '../runs/agentRunTranscript.js';

const budget: AgentBudget = {
  assertWithinLimits: () => undefined,
  remainingOutputTokens: () => 64,
  recordUsage: () => undefined,
  reserveToolCall: () => undefined,
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
      fail: vi.fn(),
      cancel: vi.fn(),
    } as unknown as AgentRunStore;
    const transcript = {
      record: vi.fn((_id, event) => { order.push(`transcript:${event.type}`); }),
    } as unknown as AgentRunTranscript;
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const prepareSubagent = vi.fn(async (input): Promise<AgentLoopInput> => {
      await preparationGate;
      const llm = {
        protocol: 'openai-llm',
        stream: () => (async function* () {
          yield { type: 'text_delta' as const, blockIndex: 0, delta: 'answer' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const };
        })(),
      } as unknown as LanguageModel;
      return {
        history: [],
        currentMessages: [{ role: 'user', content: input.prompt }],
        prepareIteration: async ({ currentMessages }) => ({
          request: { model: 'test', messages: currentMessages },
          history: [],
        }),
        llm,
        createToolExecutor: () => idleExecutor(),
        budget,
        signal: input.signal,
        maxIterations: 2,
      };
    });
    const events: string[] = [];
    const spawner = new SubagentSpawner({
      parentSessionId: 'session-1',
      parentTurnId: 'turn-1',
      budget,
      prepareSubagent,
      agentRunStore,
      transcript,
      emit: (event) => {
        order.push(
          event.type === 'agent_run_event'
            ? `emit:${event.type}:${event.event.type}`
            : `emit:${event.type}`,
        );
        events.push(event.type);
      },
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
      'agent_run_event',
      'agent_run_event',
      'agent_run_event',
      'agent_run_event',
      'agent_run_completed',
    ]);
  });
});
