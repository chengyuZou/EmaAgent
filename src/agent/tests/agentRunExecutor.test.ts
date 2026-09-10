// 验证进程级 AgentRun 的结果归属: 前台直接返回, 转后台后通知 Session, 持久终态可重复读取.

import type { StreamingToolExecutor } from '@ema-agent/tools';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunExecutor, type StartAgentRun } from '../agentRunExecutor.js';
import type { AgentRunMessagesStore } from '../runs/agentRunMessagesStore.js';
import type { AgentRunStore } from '../runs/agentRunStore.js';
import type { AgentRun, AgentRunCompletion, AgentRunStart } from '../runs/types.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
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

function makeStore(initial?: AgentRun): AgentRunStore {
  const runs = new Map<string, AgentRun>();
  if (initial) runs.set(initial.id, initial);
  return {
    start(input: AgentRunStart) {
      const now = Date.now();
      const run: AgentRun = {
        id: input.agentRunId,
        sessionId: input.sessionId,
        parentTurnId: input.parentTurnId,
        contextMode: input.contextMode,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      runs.set(run.id, run);
      return run;
    },
    get: (id: string) => runs.get(id),
    complete(id: string, completion: AgentRunCompletion) {
      const current = runs.get(id)!;
      const run: AgentRun = {
        ...current,
        ...completion,
        status: 'completed',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      };
      runs.set(id, run);
      return { ok: true as const, changed: true, run };
    },
    fail(id: string, error: string) {
      const run: AgentRun = { ...runs.get(id)!, status: 'failed', error, updatedAt: Date.now() };
      runs.set(id, run);
      return { ok: true as const, changed: true, run };
    },
    cancel(id: string, error: string) {
      const run: AgentRun = { ...runs.get(id)!, status: 'cancelled', error, updatedAt: Date.now() };
      runs.set(id, run);
      return { ok: true as const, changed: true, run };
    },
  } as unknown as AgentRunStore;
}

function makeInput(agentRunId: string, gate: Promise<void>, parentSignal: AbortSignal): StartAgentRun {
  return {
    sessionId: 'session-1',
    parentTurnId: 'turn-1',
    prompt: '检查实现',
    options: { agentRunId, contextMode: 'subagent' },
    parentSignal,
    runInBackground: false,
    prepareSubagent: async ({ signal }) => ({
      messages: [{ role: 'user', content: '检查实现' }],
      prepareIteration: async ({ messages }) => ({ request: { messages }, messages }),
      callLlm: () => (async function* () {
        await gate;
        if (signal.aborted) throw signal.reason;
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '完成' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })(),
      createToolExecutor: () => idleExecutor(),
      signal,
      maxIterations: 2,
      generationSource: {
        providerId: 'provider-1',
        modelId: 'model-1',
        protocol: 'openai-llm',
      },
    }),
  };
}

function createExecutor(store: AgentRunStore) {
  const onBackgroundCompleted = vi.fn();
  const onTerminalResultRead = vi.fn();
  const executor = new AgentRunExecutor({
    store,
    messages: { record: vi.fn() } as unknown as AgentRunMessagesStore,
    maxConcurrent: () => 4,
    publish: vi.fn(),
    onBackgroundCompleted,
    onTerminalResultRead,
  });
  return { executor, onBackgroundCompleted, onTerminalResultRead };
}

describe('AgentRunExecutor', () => {
  it('前台等待方取得结果后不再向 Session 重复通知', async () => {
    const gate = deferred();
    const fixture = createExecutor(makeStore());
    fixture.executor.start(makeInput('run-1', gate.promise, new AbortController().signal));
    const result = fixture.executor.waitForInitialResult(
      'run-1',
      'session-1',
      new AbortController().signal,
    );

    gate.resolve();

    await expect(result).resolves.toMatchObject({ output: '完成' });
    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).not.toHaveBeenCalled());
  });

  it('转后台解除父 Turn 取消关系, 终态只发送轻量通知', async () => {
    const gate = deferred();
    const parent = new AbortController();
    const fixture = createExecutor(makeStore());
    fixture.executor.start(makeInput('run-2', gate.promise, parent.signal));

    fixture.executor.moveToBackground('run-2', 'session-1');
    parent.abort(new Error('父 Turn 已结束'));
    gate.resolve();

    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).toHaveBeenCalledWith(
      'session-1', 'run-2', 'completed',
    ));
  });

  it('已持久化终态可以按 id 重复读取', async () => {
    const stored: AgentRun = {
      id: 'run-3',
      sessionId: 'session-1',
      parentTurnId: 'turn-1',
      contextMode: 'subagent',
      status: 'completed',
      finalText: '持久结果',
      inputTokens: 5,
      outputTokens: 8,
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    };
    const fixture = createExecutor(makeStore(stored));

    const first = await fixture.executor.awaitResult('run-3', 'session-1', new AbortController().signal);
    const second = await fixture.executor.awaitResult('run-3', 'session-1', new AbortController().signal);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ output: '持久结果' });
    expect(fixture.onTerminalResultRead).toHaveBeenCalledTimes(2);
  });
});
