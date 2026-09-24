// 验证进程级 Subagent 的结果归属: 前台直接返回, 转后台后通知 Session, 持久终态可重复读取.

import type { StreamingToolExecutor } from '@ema-agent/tools';
import { describe, expect, it, vi } from 'vitest';
import { SubagentExecutor, type StartSubagent } from '../subagentExecutor.js';
import type { SubagentMessagesStore } from '../subagents/subagentMessagesStore.js';
import type { SubagentStore } from '../subagents/subagentStore.js';
import type { Subagent, SubagentCompletion, SubagentStart } from '../subagents/types.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function idleExecutor(): StreamingToolExecutor {
  return {
    addTool: vi.fn(),
    allDone: () => true,
    hasWaitingUserTool: () => false,
    takeCompletedResults: () => [],
    acknowledgeResult: vi.fn(),
  } as unknown as StreamingToolExecutor;
}

function makeStore(initial?: Subagent): SubagentStore {
  const subagents = new Map<string, Subagent>();
  if (initial) subagents.set(initial.id, initial);
  return {
    start(input: SubagentStart) {
      const now = Date.now();
      const subagent: Subagent = {
        id: input.subagentId,
        sessionId: input.sessionId,
        parentTurnId: input.parentTurnId,
        contextMode: input.contextMode,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      subagents.set(subagent.id, subagent);
      return subagent;
    },
    get: (id: string) => subagents.get(id),
    complete(id: string, completion: SubagentCompletion) {
      const current = subagents.get(id)!;
      const subagent: Subagent = {
        ...current,
        ...completion,
        status: 'completed',
        updatedAt: Date.now(),
        completedAt: Date.now(),
      };
      subagents.set(id, subagent);
    },
    fail(id: string, error: string) {
      const subagent: Subagent = { ...subagents.get(id)!, status: 'failed', error, updatedAt: Date.now() };
      subagents.set(id, subagent);
    },
    cancel(id: string, error: string) {
      const subagent: Subagent = { ...subagents.get(id)!, status: 'cancelled', error, updatedAt: Date.now() };
      subagents.set(id, subagent);
    },
  } as unknown as SubagentStore;
}

function makeInput(subagentId: string, gate: Promise<void>, parentSignal: AbortSignal): StartSubagent {
  return {
    sessionId: 'session-1',
    parentTurnId: 'turn-1',
    prompt: '检查实现',
    options: { subagentId, contextMode: 'subagent' },
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

function createExecutor(store: SubagentStore) {
  const onBackgroundCompleted = vi.fn();
  const onTerminalResultRead = vi.fn();
  const publish = vi.fn();
  const executor = new SubagentExecutor({
    store,
    messages: { record: vi.fn(), interruptActiveAssistant: vi.fn() } as unknown as SubagentMessagesStore,
    maxConcurrent: () => 4,
    publish,
    onBackgroundCompleted,
    onTerminalResultRead,
  });
  return { executor, publish, onBackgroundCompleted, onTerminalResultRead };
}

describe('SubagentExecutor', () => {
  it('完成落库失败不会发布完成事件, 也不会改写为执行失败', async () => {
    const gate = deferred();
    const store = makeStore();
    vi.spyOn(store, 'complete').mockImplementation(() => {
      throw new Error('完成落库失败');
    });
    const fixture = createExecutor(store);
    fixture.executor.start(makeInput('subagent-write-error', gate.promise, new AbortController().signal));
    const result = fixture.executor.waitForInitialResult(
      'subagent-write-error',
      'session-1',
      new AbortController().signal,
    );

    gate.resolve();

    await expect(result).rejects.toThrow('完成落库失败');
    expect(store.get('subagent-write-error')?.status).toBe('running');
    expect(fixture.publish).not.toHaveBeenCalledWith('session-1', {
      type: 'subagent_completed',
      subagentId: 'subagent-write-error',
    });
    expect(fixture.publish).not.toHaveBeenCalledWith('session-1', expect.objectContaining({
      type: 'subagent_failed',
    }));
  });

  it('前台等待方取得结果后不再向 Session 重复通知', async () => {
    const gate = deferred();
    const fixture = createExecutor(makeStore());
    fixture.executor.start(makeInput('subagent-1', gate.promise, new AbortController().signal));
    const result = fixture.executor.waitForInitialResult(
      'subagent-1',
      'session-1',
      new AbortController().signal,
    );

    gate.resolve();

    await expect(result).resolves.toMatchObject({ output: '完成' });
    expect(fixture.publish).toHaveBeenCalledWith('session-1', {
      type: 'subagent_completed',
      subagentId: 'subagent-1',
    });
    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).not.toHaveBeenCalled());
  });

  it('转后台解除父 Turn 取消关系, 终态只发送轻量通知', async () => {
    const gate = deferred();
    const parent = new AbortController();
    const fixture = createExecutor(makeStore());
    fixture.executor.start(makeInput('subagent-2', gate.promise, parent.signal));

    fixture.executor.moveToBackground('subagent-2', 'session-1');
    parent.abort(new Error('父 Turn 已结束'));
    gate.resolve();

    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).toHaveBeenCalledWith(
      'session-1', 'subagent-2', 'completed',
    ));
  });

  it('停止 SubagentAwait 只结束等待, 后台 Subagent 继续完成', async () => {
    const gate = deferred();
    const fixture = createExecutor(makeStore());
    fixture.executor.start(makeInput('subagent-await', gate.promise, new AbortController().signal));
    fixture.executor.moveToBackground('subagent-await', 'session-1');

    const waiting = new AbortController();
    const result = fixture.executor.awaitResult('subagent-await', 'session-1', waiting.signal);
    waiting.abort(new Error('用户停止等待'));

    await expect(result).resolves.toBeNull();
    gate.resolve();
    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).toHaveBeenCalledWith(
      'session-1', 'subagent-await', 'completed',
    ));
  });

  it('已持久化终态可以按 id 重复读取', async () => {
    const stored: Subagent = {
      id: 'subagent-3',
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

    const first = await fixture.executor.awaitResult('subagent-3', 'session-1', new AbortController().signal);
    const second = await fixture.executor.awaitResult('subagent-3', 'session-1', new AbortController().signal);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ output: '持久结果' });
    expect(fixture.onTerminalResultRead).toHaveBeenCalledTimes(2);
  });
});
