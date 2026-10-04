// 验证进程级 Subagent 的结果归属: 前台直接返回, 转后台后通知 Session, 持久终态可重复读取.

import type { StreamingToolExecutor, ToolResult } from '@ema-agent/tools';
import { BuiltinTools } from '@ema-agent/tools/identity';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubagentExecutor, type StartSubagent } from '../subagentExecutor.js';
import type { SubagentMessagesStore } from '../subagents/subagentMessagesStore.js';
import type { SubagentStore } from '../subagents/subagentStore.js';
import { Database, SubagentMessagesRepo, SubagentRunsRepo, SubagentsRepo } from '@ema-agent/storage';
import { SubagentMessagesStore as MessagesStore } from '../subagents/subagentMessagesStore.js';
import { SubagentStore as Store } from '../subagents/subagentStore.js';

const databases = new Set<Database>();
const messageStores = new Map<SubagentStore, SubagentMessagesStore>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  messageStores.clear();
});

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

function makeStore(initial?: { id: string; finalText: string; inputTokens: number; outputTokens: number }): SubagentStore {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  db.sqlite.prepare("INSERT INTO sessions (id,title,cwd,created_at,updated_at) VALUES ('session-1','会话','',1,1)").run();
  databases.add(db);
  const store = new Store(db.sqlite, new SubagentsRepo(db.sqlite), new SubagentRunsRepo(db.sqlite));
  messageStores.set(store, new MessagesStore(new SubagentMessagesRepo(db.sqlite)));
  if (initial) {
    store.start({
      subagentId: initial.id, runId: initial.id + '-run', toolCallId: 'initial-call',
      sessionId: 'session-1', title: '历史代理', description: '历史任务',
      contextMode: 'subagent', isNew: true,
    });
    store.complete(initial.id + '-run', { ...initial, iterations: 1, toolCallCount: 0 });
  }
  return store;
}

function makeInput(toolCallId: string, gate: Promise<void>, parentSignal: AbortSignal): StartSubagent {
  return {
    sessionId: 'session-1',
    parentTurnId: 'turn-1',
    toolCallId,
    prompt: '检查实现',
    options: { contextMode: 'subagent', title: '检查实现', description: '检查实现边界' },
    permissionMode: 'default',
    reasoningEffort: 'high',
    parentSignal,
    runInBackground: false,
    prepareSubagent: async ({ signal, subagentId, runId, messageStore, prompt, messageIds, options }) => {
      messageStore.initialize(subagentId, runId, prompt);
      messageIds.push(...messageStore.loadHistory(subagentId).map(message => message.id));
      return ({
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
        providerId: options.providerId ?? 'provider-1',
        modelId: options.modelId ?? 'model-1',
        protocol: 'openai-llm',
      },
    });
    },
  };
}

function createExecutor(store: SubagentStore) {
  const onBackgroundCompleted = vi.fn();
  const onTerminalResultRead = vi.fn();
  const onRunFinished = vi.fn();
  const publish = vi.fn();
  const executor = new SubagentExecutor({
    store,
    messageStore: messageStores.get(store)!,
    maxConcurrent: () => 4,
    publish,
    onBackgroundCompleted,
    onTerminalResultRead,
    onRunFinished,
  });
  return { executor, publish, onBackgroundCompleted, onTerminalResultRead, onRunFinished };
}

describe('SubagentExecutor', () => {
  it('流式与闭合事件沿用真实 SQL ID, 终态携带具体 Run 的持久结果', async () => {
    const store = makeStore();
    const fixture = createExecutor(store);
    const reference = fixture.executor.start(makeInput('stable-message', Promise.resolve(), new AbortController().signal));
    const result = await fixture.executor.waitForInitialResult(reference.subagentId, 'session-1', new AbortController().signal);
    expect(result).toMatchObject(reference);
    const events = fixture.publish.mock.calls.map(([, event]) => event);
    const updates = events.filter(event => event.type === 'message_updated' && event.message.role === 'assistant');
    expect(updates.length).toBeGreaterThan(1);
    expect(new Set(updates.map(event => event.message.id)).size).toBe(1);
    const stored = messageStores.get(store)!.get(updates[0].message.id)!;
    expect(updates.at(-1)).toMatchObject({ ...reference, message: stored, streaming: false });
    expect(events.find(event => event.type === 'subagent_completed')).toMatchObject({ ...reference, run: store.getRun(reference.runId) });
  });
  it.each(['completed', 'failed', 'cancelled'] as const)('Run %s 后只通知一次实际 runId', async status => {
    const store = makeStore();
    const fixture = createExecutor(store);
    const gate = deferred();
    const parent = new AbortController();
    const input = makeInput('parent-call', gate.promise, parent.signal);
    const originalPrepare = input.prepareSubagent;
    let actualRunId = '';
    const { subagentId: subagentId } = fixture.executor.start({
      ...input,
      prepareSubagent: async args => {
        actualRunId = args.runId;
        if (status === 'failed') throw new Error('prepare failed');
        return originalPrepare(args);
      },
    });
    const result = fixture.executor.waitForInitialResult(subagentId, 'session-1', new AbortController().signal);
    if (status === 'cancelled') parent.abort(new Error('stop'));
    gate.resolve();
    if (status === 'completed') await expect(result).resolves.toMatchObject({ output: '完成' });
    else await expect(result).rejects.toThrow();
    expect(store.getRun(actualRunId)?.status).toBe(status);
    expect(fixture.onRunFinished).toHaveBeenCalledTimes(1);
    expect(fixture.onRunFinished).toHaveBeenCalledWith(actualRunId);
  });

  it.each([false, true])('工具结果带原始工具名, 成功与失败都不需要消费者扫描消息(isError=%s)', async isError => {
    const fixture = createExecutor(makeStore());
    const input = makeInput('parent-call', Promise.resolve(), new AbortController().signal);
    const prepare = input.prepareSubagent;
    const toolResult: ToolResult = {
      type: 'tool_result',
      toolCallId: 'write-call',
      content: 'result',
      isError,
    };
    let registered = false;
    let delivered = false;
    let iteration = 0;
    const toolExecutor = {
      ...idleExecutor(),
      addTool: () => { registered = true; },
      takeCompletedResults: () => {
        if (!registered || delivered) return [];
        delivered = true;
        return [toolResult];
      },
    } as unknown as StreamingToolExecutor;
    const { subagentId: subagentId } = fixture.executor.start({
      ...input,
      prepareSubagent: async args => ({
        ...await prepare(args),
        createToolExecutor: () => toolExecutor,
        callLlm: () => (async function* () {
          if (iteration++ === 0) {
            yield {
              type: 'tool_use_complete' as const,
              blockIndex: 0,
              callId: toolResult.toolCallId,
              name: BuiltinTools.FileWrite.name,
              args: {},
            };
            yield { type: 'done' as const, stopReason: 'tool_use' as const };
          } else {
            yield { type: 'done' as const, stopReason: 'end_turn' as const };
          }
        })(),
      }),
    });
    await fixture.executor.waitForInitialResult(subagentId, 'session-1', new AbortController().signal);
    expect(fixture.publish).toHaveBeenCalledWith('session-1', expect.objectContaining({ type: 'tool_result', subagentId, toolName: BuiltinTools.FileWrite.name, result: toolResult }));
  });

  it('完成落库失败不会发布完成事件, 也不会改写为执行失败', async () => {
    const gate = deferred();
    const store = makeStore();
    vi.spyOn(store, 'complete').mockImplementation(() => {
      throw new Error('完成落库失败');
    });
    const fixture = createExecutor(store);
    const { subagentId: subagentId } = fixture.executor.start(makeInput('call-write-error', gate.promise, new AbortController().signal));
    expect(subagentId).not.toBe('call-write-error');
    const result = fixture.executor.waitForInitialResult(
      subagentId,
      'session-1',
      new AbortController().signal,
    );

    gate.resolve();

    await expect(result).rejects.toThrow('完成落库失败');
    expect(store.get(subagentId)?.status).toBe('running');
    expect(fixture.publish).not.toHaveBeenCalledWith('session-1', expect.objectContaining({ type: 'subagent_completed', subagentId }));
    expect(fixture.publish).not.toHaveBeenCalledWith('session-1', expect.objectContaining({
      type: 'subagent_failed',
    }));
  });

  it('前台等待方取得结果后不再向 Session 重复通知', async () => {
    const gate = deferred();
    const fixture = createExecutor(makeStore());
    const { subagentId: subagentId } = fixture.executor.start(makeInput('call-1', gate.promise, new AbortController().signal));
    const result = fixture.executor.waitForInitialResult(
      subagentId,
      'session-1',
      new AbortController().signal,
    );

    gate.resolve();

    await expect(result).resolves.toMatchObject({ output: '完成' });
    expect(fixture.publish).toHaveBeenCalledWith('session-1', expect.objectContaining({ type: 'subagent_completed', subagentId }));
    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).not.toHaveBeenCalled());
  });

  it('转后台解除父 Turn 取消关系, 终态只发送轻量通知', async () => {
    const gate = deferred();
    const parent = new AbortController();
    const fixture = createExecutor(makeStore());
    const { subagentId: subagentId } = fixture.executor.start(makeInput('call-2', gate.promise, parent.signal));

    fixture.executor.moveToBackground(subagentId, 'session-1');
    parent.abort(new Error('父 Turn 已结束'));
    gate.resolve();

    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).toHaveBeenCalledWith(
      'session-1', subagentId, 'completed',
    ));
  });

  it('停止 SubagentAwait 只结束等待, 后台 Subagent 继续完成', async () => {
    const gate = deferred();
    const fixture = createExecutor(makeStore());
    const { subagentId: subagentId } = fixture.executor.start(makeInput('call-await', gate.promise, new AbortController().signal));
    fixture.executor.moveToBackground(subagentId, 'session-1');

    const waiting = new AbortController();
    const result = fixture.executor.awaitResult(subagentId, 'session-1', waiting.signal);
    waiting.abort(new Error('用户停止等待'));

    await expect(result).resolves.toBeNull();
    gate.resolve();
    await vi.waitFor(() => expect(fixture.onBackgroundCompleted).toHaveBeenCalledWith(
      'session-1', subagentId, 'completed',
    ));
  });

  it('已持久化终态可以按 id 重复读取', async () => {
    const stored = {
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

describe('持久子代理继续', () => {
  it('同 ID 多 Run, 未提供模型时沿用最近实际模型, Permission 和强度用父本次值', async () => {
    const store = makeStore();
    const fixture = createExecutor(store);
    const firstInput = makeInput('first', Promise.resolve(), new AbortController().signal);
    const { subagentId: id } = fixture.executor.start({
      ...firstInput, options: { ...firstInput.options, providerId: 'custom-p', modelId: 'custom-m' },
      permissionMode: 'bypassPermissions', reasoningEffort: 'low',
    });
    await fixture.executor.waitForInitialResult(id, 'session-1', new AbortController().signal);
    const firstRun = store.latestRun(id)!;
    const prepared = vi.fn(makeInput('second', Promise.resolve(), new AbortController().signal).prepareSubagent);
    const { subagentId: continuedId } = fixture.executor.start({
      ...makeInput('second', Promise.resolve(), new AbortController().signal),
      options: { subagentId: id }, permissionMode: 'default', reasoningEffort: 'high', prepareSubagent: prepared,
    });
    expect(continuedId).toBe(id);
    await fixture.executor.waitForInitialResult(id, 'session-1', new AbortController().signal);
    const secondRun = store.latestRun(id)!;
    expect(secondRun.id).not.toBe(firstRun.id);
    expect(secondRun).toMatchObject({ providerId: 'custom-p', modelId: 'custom-m', permissionMode: 'default', reasoningEffort: 'high', status: 'completed' });
    expect(store.getRun(firstRun.id)).toMatchObject({ permissionMode: 'bypassPermissions', reasoningEffort: 'low', status: 'completed' });
    expect(store.get(id)?.title).toBe('检查实现');
    expect(prepared.mock.calls[0]![0]).toMatchObject({ isNew: false, options: { providerId: 'custom-p', modelId: 'custom-m' } });
    expect(messageStores.get(store)!.loadHistory(id).filter(message => message.kind === 'normal' && message.role === 'user')).toHaveLength(2);
  });

  it('运行中不能复用, 不创建第二条 Run', async () => {
    const gate = deferred();
    const store = makeStore();
    const fixture = createExecutor(store);
    const input = makeInput('first', gate.promise, new AbortController().signal);
    const { subagentId: id } = fixture.executor.start(input);
    expect(() => fixture.executor.start({ ...input, toolCallId: 'second', options: { subagentId: id } })).toThrow('正在被占用');
    expect(store.listRuns(id).items).toHaveLength(1);
    gate.resolve();
    await fixture.executor.waitForInitialResult(id, 'session-1', new AbortController().signal);
  });

  it('显式模型配置准备失败就报错, 不悄悄回退; 错误保存到本次 Run', async () => {
    const store = makeStore();
    const fixture = createExecutor(store);
    const input = makeInput('invalid', Promise.resolve(), new AbortController().signal);
    const { subagentId: id } = fixture.executor.start({
      ...input, options: { ...input.options, providerId: 'missing', modelId: 'missing' },
      prepareSubagent: async () => { throw new Error('模型不存在'); },
    });
    await expect(fixture.executor.waitForInitialResult(id, 'session-1', new AbortController().signal)).rejects.toThrow('模型不存在');
    expect(store.latestRun(id)).toMatchObject({ status: 'failed', error: '模型不存在', providerId: null });
    expect(store.get(id)).toMatchObject({ status: 'failed', providerId: null });
  });
});
