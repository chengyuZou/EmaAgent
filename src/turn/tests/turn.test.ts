// 集成测试：TurnExecutor 全链——文本轮完成、工具轮的持久化顺序与终态。
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { z } from 'zod';
import { SubagentExecutor, SubagentStore, SubagentMessagesStore } from '@ema-agent/agent';
import type { AttachmentStore } from '@ema-agent/attachments';
import type { CallLlm, LlmStreamEvent, Message } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { Database, SubagentsRepo, SubagentMessagesRepo } from '@ema-agent/storage';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { StageEngine } from '@ema-agent/stage';
import type { UsageRecord } from '@ema-agent/usage';
import { GoalStore } from '@ema-agent/goal';
import {
  buildTool,
  BuiltinTools,
  contextOk,
  ToolRegistry,
} from '@ema-agent/tools';
import { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';
import { TurnExecutor, type TurnExecutorDeps } from '../turn.js';
import { TurnStore } from '../turnStore.js';
import type { StartTurn, TurnHandle } from '../types.js';
import { SessionContinuationQueue } from '../sessionContinuationQueue.js';
import { SubagentTool } from '../../builtin-tools/tools/SubagentTool/SubagentTool.js';
import { GoalGetTool } from '../../builtin-tools/tools/GoalGetTool/GoalGetTool.js';
import { GoalUpdateTool } from '../../builtin-tools/tools/GoalUpdateTool/GoalUpdateTool.js';

function scriptedLlm(calls: LlmStreamEvent[][]): CallLlm {
  let index = 0;
  return async function* () {
    const events = calls[Math.min(index, calls.length - 1)]!;
    index += 1;
    for (const event of events) yield event;
  };
}

function fakeSettingsStore(): SettingsStore {
  const values = new Map<string, unknown>();
  return {
    get: (def: { key: string; defaultValue: unknown }) =>
      values.has(def.key) ? values.get(def.key) : def.defaultValue,
    set: (def: { key: string }, value: unknown) => { values.set(def.key, value); },
  } as unknown as SettingsStore;
}

function echoTool() {
  return buildTool({
    name: 'Echo',
    description: 'echo',
    inputSchema: z.object({}),
    validateContext: () => contextOk({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    execute: async () => ({ kind: 'echo_result' as const, value: 'echo-ok' }),
  });
}

function makeDeps(options: {
  db: Database;
  llm: CallLlm;
  sessionId: string;
  registry: ToolRegistry;
}): TurnExecutorDeps {
  const { db, llm, sessionId, registry } = options;
  return {
    turns: new TurnStore({ db, sessionRunning: new SessionRunningRegistry() }),
    sessions: new SessionStore({ db }),
    providers: {
      resolveConnection: () => ({ protocol: 'openai-chat', baseUrl: 'http://localhost' }),
    } as unknown as Providers,
    providerModels: {
      get: () => ({
        capability: 'llm',
        contextWindow: 200_000,
        maxOutput: null,
        toolCall: true,
        reasoning: null,
        temperature: null,
        inputImage: false,
      }),
    } as unknown as ProviderModels,
    attachments: {
      addAll: async () => [],
      getMany: () => new Map(),
    } as unknown as AttachmentStore,
    settings: fakeSettingsStore(),
    characterPrompt: () => ['你是测试角色'],
    skillEntries: () => [],
    createLlmCall: () => llm,
    registry,
    interactionQueue: new SessionInteractionQueue(null),
    subagents: {
      abortForegroundForTurn: async () => undefined,
      waitForTurnSubagents: async () => undefined,
    } as unknown as SubagentExecutor,
    continuations: {
      acknowledge: () => undefined,
      claimNextIteration: () => undefined,
      release: () => undefined,
      turnFinished: () => undefined,
    } as never,
    createCompact: () => async request => ({ kind: 'unchanged' as const, messages: request.messages }),
    readTurnReminder: () => ({ currentDate: '2026-08-25', goal: null }),
    characterName: () => 'test-character',
  };
}

function makeStart(sessionId: string): StartTurn {
  return {
    sessionId,
    triggerType: 'userMessage',
    sessionMode: 'work',
    narrativePolicy: 'off',
    ttsEnabled: true,
    input: [{ type: 'text', text: '你好' }],
  };
}

function goalContinuationFixture(llm: CallLlm) {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  const sessions = new SessionStore({ db });
  const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm', sessionMode: 'work' });
  const sessionRunning = new SessionRunningRegistry();
  const turns = new TurnStore({ db, sessionRunning });
  const registry = new ToolRegistry();
  registry.register(GoalGetTool);
  registry.register(GoalUpdateTool);
  const handles: TurnHandle[] = [];
  let queue: SessionContinuationQueue;
  const goals = new GoalStore(db, event => {
    if (event.type === 'goal_created' || event.type === 'goal_activated') queue.requestDrain(event.goal.sessionId);
  });
  const deps = makeDeps({ db, llm, sessionId: session.id, registry });
  let executor: TurnExecutor;
  queue = new SessionContinuationQueue({
    sessions, sessionRunning, goals,
    startTurn: input => executor.start(input),
    attachTurn: handle => { handles.push(handle); },
    publish: () => undefined,
  });
  executor = new TurnExecutor({
    ...deps, sessions, turns, goalStore: goals, continuations: queue,
    readTurnReminder: () => ({ currentDate: '2026-09-29', goal: goals.getCurrent(session.id) }),
  });
  return { db, sessions, session, sessionRunning, turns, registry, goals, queue, executor, handles, deps };
}

function forkFixture(llm: CallLlm, onStarted: (id: string) => void) {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  const sessions = new SessionStore({ db });
  const session = sessions.createSession({
    cwd: os.tmpdir(), providerId: 'p', modelId: 'm', permissionMode: 'bypassPermissions',
  });
  const registry = new ToolRegistry();
  registry.register(SubagentTool);
  const store = new SubagentStore(new SubagentsRepo(db.sqlite));
  const subagents = new SubagentExecutor({
    store,
    messages: new SubagentMessagesStore(new SubagentMessagesRepo(db.sqlite)),
    maxConcurrent: () => 8,
    publish: (_sessionId, event) => {
      if (event.type === 'subagent_started') onStarted(event.subagentId);
    },
    onBackgroundCompleted: () => undefined,
    onTerminalResultRead: () => undefined,
  });
  const executor = new TurnExecutor({
    ...makeDeps({ db, llm, sessionId: session.id, registry }),
    subagents,
  });
  return { db, sessions, session, store, subagents, executor };
}

describe('TurnExecutor 集成', () => {
  it('初始 Goal 与用户任务只启动一根 Turn, 短续接和用户 Message 分别落库, 编辑不添加用户气泡', async () => {
    const objective = '  原始任务\r\n第二行  ';
    let fixture: ReturnType<typeof goalContinuationFixture>;
    let requests = 0;
    const llm: CallLlm = async function* (request) {
      requests += 1;
      const goal = fixture.goals.getCurrent(fixture.session.id)!;
      const edited = fixture.goals.edit({ sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version }, '后续手动修改');
      fixture.goals.complete({ sessionId: edited.sessionId, goalId: edited.id, expectedVersion: edited.version }, '目标已完成');
      yield { type: 'text_delta', blockIndex: 0, delta: '初始任务已处理' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    fixture = goalContinuationFixture(llm);
    try {
      const goal = fixture.goals.create(fixture.session.id, objective);
      fixture.queue.enqueue({ sessionId: fixture.session.id,
        input: [{ type: 'text', text: objective }], selection: { sessionMode: 'work', narrativePolicy: 'off' } });
      await vi.waitFor(() => expect(fixture.handles).toHaveLength(1));
      const handle = fixture.handles[0]!;
      expect((await handle.completion).status).toBe('completed');
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(1);
      expect(requests).toBe(1);
      const userMessages = fixture.sessions.loadMessagesForTurn(handle.turnId).filter(message => message.role === 'user');
      expect(userMessages.map(message => message.kind)).toEqual(['reminder', 'continuation', 'normal']);
      expect(userMessages[1]!.blocks).toBe('根据本轮 reminder 和 GoalGet 继续推进当前目标. '
        + '目标已暂停或关闭时不要继续历史目标, 不自行创建或激活目标.');
      expect(userMessages[2]!.blocks).toBe(objective);
      expect(fixture.goals.get(fixture.session.id, goal.id)?.objective).toBe('后续手动修改');
      const events: TurnStreamEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(events.filter(event => event.type === 'user_message_stored')).toHaveLength(1);
      expect(fixture.queue.list(fixture.session.id)).toEqual([]);
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it('真实 Goal 工具报告进度后经同一队列开启下一根 Turn, 完成目标后不再续接', async () => {
    const requests: string[] = [];
    let fixture: ReturnType<typeof goalContinuationFixture>;
    const llm: CallLlm = async function* (request) {
      requests.push(JSON.stringify(request.messages));
      const goal = fixture.goals.getCurrent(fixture.session.id)!;
      if (requests.length === 1 || requests.length === 3) {
        const args = requests.length === 1
          ? { goalId: goal.id, expectedVersion: goal.version, status: 'active', feedback: '已读 2/8, 下一轮继续' }
          : { goalId: goal.id, expectedVersion: goal.version, status: 'completed', reason: 'succeeded', feedback: '8/8 已读完并整理' };
        yield { type: 'tool_use_complete', blockIndex: 0, callId: `goal-${requests.length}`, name: 'GoalUpdate', args };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', blockIndex: 0, delta: '阶段汇报' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    fixture = goalContinuationFixture(llm);
    try {
      const goal = fixture.goals.create(fixture.session.id, '整理 8 个 README');
      const first = fixture.executor.start(makeStart(fixture.session.id));
      expect((await first.completion).status).toBe('completed');
      await vi.waitFor(() => expect(fixture.handles).toHaveLength(1));
      const second = fixture.handles[0]!;
      expect((await second.completion).status).toBe('completed');
      await Promise.resolve();
      expect(requests).toHaveLength(4);
      expect(fixture.handles).toHaveLength(1);
      expect(fixture.goals.get(fixture.session.id, goal.id)).toMatchObject({ status: 'completed', reason: 'succeeded' });
      expect(requests[2]).toContain('已读 2/8, 下一轮继续');
      const messages = fixture.sessions.loadMessagesForTurn(second.turnId);
      expect(messages.filter(message => message.role === 'user').map(message => message.kind))
        .toEqual(['reminder', 'continuation', 'tool_results']);
      const events: TurnStreamEvent[] = [];
      for await (const event of second.events) events.push(event);
      expect(events.some(event => event.type === 'user_message_stored')).toBe(false);
      expect(fixture.sessionRunning.isRunning(fixture.session.id)).toBe(false);
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it.each(['cancel', 'delete'] as const)('当前模型执行中 %s Goal, 本轮正常完成且不复活目标或启动下一轮', async action => {
    let fixture: ReturnType<typeof goalContinuationFixture>;
    const llm: CallLlm = async function* () {
      const goal = fixture.goals.getCurrent(fixture.session.id)!;
      fixture.goals[action]({ sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version });
      yield { type: 'text_delta', blockIndex: 0, delta: '本轮继续完成' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    fixture = goalContinuationFixture(llm);
    try {
      fixture.goals.create(fixture.session.id, '关闭不停止当前 Turn');
      const handle = fixture.executor.start(makeStart(fixture.session.id));
      expect((await handle.completion).status).toBe('completed');
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(0);
      expect(fixture.goals.getCurrent(fixture.session.id)).toBeNull();
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it('用户停止时暂停同一 Goal 的当前 active 版本, 不被 feedback 和编辑增加的版本漏掉', async () => {
    let fixture: ReturnType<typeof goalContinuationFixture>;
    let handle: TurnHandle;
    const llm: CallLlm = async function* (request) {
      const goal = fixture.goals.getCurrent(fixture.session.id)!;
      const progress = fixture.goals.reportFeedback({ sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version }, '已完成部分');
      fixture.goals.edit({ sessionId: goal.sessionId, goalId: goal.id, expectedVersion: progress.version }, '修改后的要求');
      handle.abort();
      request.signal?.throwIfAborted();
      yield { type: 'done', stopReason: 'end_turn' };
    };
    fixture = goalContinuationFixture(llm);
    try {
      const goal = fixture.goals.create(fixture.session.id, '初始目标');
      handle = fixture.executor.start(makeStart(fixture.session.id));
      expect((await handle.completion).status).toBe('aborted');
      await Promise.resolve();
      expect(fixture.goals.getCurrent(fixture.session.id)).toMatchObject({
        id: goal.id, status: 'paused', version: 4, objective: '修改后的要求', reason: null, error: null,
      });
      expect(fixture.handles).toHaveLength(0);
      expect(fixture.sessionRunning.isRunning(fixture.session.id)).toBe(false);
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it.each(['same', 'replacement'] as const)('准备最终失败时只暂停本轮同一 Goal, %s 目标的处理不串身份', async target => {
    const fixture = goalContinuationFixture(scriptedLlm([[{ type: 'done', stopReason: 'end_turn' }]]));
    try {
      const goal = fixture.goals.create(fixture.session.id, '初始目标');
      const executor = new TurnExecutor({
        ...fixture.deps, turns: fixture.turns, goalStore: fixture.goals, continuations: fixture.queue,
        createLlmCall: () => {
          const identity = { sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version };
          if (target === 'same') fixture.goals.reportFeedback(identity, '调用前已经推进');
          else {
            fixture.goals.cancel(identity);
            fixture.goals.create(fixture.session.id, '后来新建的 B');
          }
          throw new Error('provider 准备失败');
        },
      });
      const handle = executor.start(makeStart(fixture.session.id));
      expect((await handle.completion).status).toBe('failed');
      const current = fixture.goals.getCurrent(fixture.session.id)!;
      if (target === 'same') {
        expect(current).toMatchObject({ id: goal.id, status: 'paused', version: 3, feedback: '调用前已经推进', reason: null });
      } else {
        expect(current.id).not.toBe(goal.id);
        expect(current).toMatchObject({ status: 'active', objective: '后来新建的 B', version: 1 });
      }
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(0);
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it('模型抛错也暂停已交付 Goal 的最新版本, 不把运行错误标成 Goal failed 完成', async () => {
    let fixture: ReturnType<typeof goalContinuationFixture>;
    const llm: CallLlm = async function* () {
      const goal = fixture.goals.getCurrent(fixture.session.id)!;
      fixture.goals.reportFeedback({ sessionId: goal.sessionId, goalId: goal.id, expectedVersion: goal.version }, '已读取部分文件');
      yield { type: 'text_delta', blockIndex: 0, delta: '尚未完成' };
      throw new Error('模型调用最终失败');
    };
    fixture = goalContinuationFixture(llm);
    try {
      const goal = fixture.goals.create(fixture.session.id, '未完成的目标');
      const handle = fixture.executor.start(makeStart(fixture.session.id));
      expect((await handle.completion).status).toBe('failed');
      expect(fixture.goals.get(fixture.session.id, goal.id)).toMatchObject({
        status: 'paused', version: 3, feedback: '已读取部分文件', reason: null, error: null,
      });
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(0);
    } finally {
      fixture.queue.shutdown();
      fixture.db.close();
    }
  });

  it('模型已结束但工具还在收尾时按停止, 仍暂停 Goal 且不立即续接', async () => {
    const fixture = goalContinuationFixture(scriptedLlm([[{ type: 'done', stopReason: 'end_turn' }]]));
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const executor = new TurnExecutor({
      ...fixture.deps, turns: fixture.turns, goalStore: fixture.goals, continuations: fixture.queue,
      readTurnReminder: () => ({ currentDate: '2026-09-29', goal: fixture.goals.getCurrent(fixture.session.id) }),
      subagents: {
        abortForegroundForTurn: async () => { cleanupStarted(); await cleanup; },
        waitForTurnSubagents: async () => undefined,
      } as unknown as SubagentExecutor,
    });
    let handle: TurnHandle | undefined;
    try {
      fixture.goals.create(fixture.session.id, '用户停止不再续接');
      handle = executor.start(makeStart(fixture.session.id));
      await started;
      handle.abort();
      releaseCleanup();
      await handle.completion;
      expect(fixture.goals.getCurrent(fixture.session.id)?.status).toBe('paused');
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(0);
    } finally {
      releaseCleanup();
      fixture.queue.shutdown();
      await handle?.completion;
      fixture.db.close();
    }
  });

  it('终态行提交后仍等工具收尾, completion 返回前解锁并阻止 Session 删除期间续接', async () => {
    const fixture = goalContinuationFixture(scriptedLlm([[{ type: 'done', stopReason: 'end_turn' }]]));
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const executor = new TurnExecutor({
      ...fixture.deps, turns: fixture.turns, goalStore: fixture.goals, continuations: fixture.queue,
      readTurnReminder: () => ({ currentDate: '2026-09-29', goal: fixture.goals.getCurrent(fixture.session.id) }),
      subagents: {
        abortForegroundForTurn: async () => { cleanupStarted(); await cleanup; },
        waitForTurnSubagents: async () => undefined,
      } as unknown as SubagentExecutor,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let handle: TurnHandle | undefined;
    try {
      fixture.goals.create(fixture.session.id, '删除期间不再启动');
      handle = executor.start(makeStart(fixture.session.id));
      await started;
      expect(fixture.turns.getTurn(handle.turnId)?.status).toBe('completed');
      expect(fixture.sessionRunning.isRunning(fixture.session.id)).toBe(true);
      expect(() => executor.start(makeStart(fixture.session.id))).toThrow('session_busy');
      fixture.turns.beginSessionDeletion(fixture.session.id);
      fixture.queue.enqueue({ sessionId: fixture.session.id,
        input: [{ type: 'text', text: '不能在删除期间开新 Turn' }],
        selection: { sessionMode: 'work', narrativePolicy: 'off' } });
      releaseCleanup();
      await handle.completion;
      expect(fixture.sessionRunning.isRunning(fixture.session.id)).toBe(false);
      fixture.queue.requestDrain(fixture.session.id);
      await Promise.resolve();
      expect(fixture.handles).toHaveLength(0);
      expect(() => executor.start(makeStart(fixture.session.id))).toThrow('session_deleting');
      expect(warn).toHaveBeenCalledWith('[continuation] Session 续接启动失败:', expect.objectContaining({ message: expect.stringContaining('session_deleting') }));
    } finally {
      releaseCleanup();
      fixture.queue.shutdown();
      await handle?.completion;
      warn.mockRestore();
      fixture.db.close();
    }
  });

  it('Plan 请求与执行共用只读池, 运行中切换权限只影响下一根 Turn', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({
      cwd: os.tmpdir(), providerId: 'p', modelId: 'm', permissionMode: 'plan', sessionMode: 'work',
    });
    const read = vi.fn(async () => 'read-ok');
    const write = vi.fn(async () => 'write-ok');
    const registry = new ToolRegistry();
    for (const [identity, execute] of [[BuiltinTools.FileRead, read], [BuiltinTools.FileWrite, write]] as const) {
      registry.register(buildTool({
        id: identity.id, name: identity.name, description: identity.name,
        inputSchema: z.object({}), validateContext: () => contextOk({}),
        checkPermissions: async () => ({ behavior: 'allow' as const }), execute,
      }));
    }
    const toolsPerCall: string[][] = [];
    const systems: string[] = [];
    const llm: CallLlm = async function* (request) {
      toolsPerCall.push((request.tools ?? []).map(tool => tool.name));
      systems.push(JSON.stringify(request.messages.filter(message => message.role === 'system')));
      if (toolsPerCall.length === 1) {
        sessions.patchSession(session.id, { permissionMode: 'bypassPermissions' });
        yield { type: 'tool_use_complete', blockIndex: 0, callId: 'write-1', name: 'Write', args: {} };
        yield { type: 'tool_use_complete', blockIndex: 1, callId: 'read-1', name: 'Read', args: {} };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', blockIndex: 0, delta: '调查完成, 方案在回复中.' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const executor = new TurnExecutor(makeDeps({ db, llm, sessionId: session.id, registry }));
    try {
      const first = executor.start(makeStart(session.id));
      expect((await first.completion).status).toBe('completed');
      expect(toolsPerCall).toEqual([['Read'], ['Read']]);
      expect(systems.every(system => system.includes('当前权限: Plan'))).toBe(true);
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      const events: TurnStreamEvent[] = [];
      for await (const event of first.events) events.push(event);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_result', callId: 'write-1', error: expect.objectContaining({ code: 'tool/unavailable' }),
      }));
      const second = executor.start(makeStart(session.id));
      expect((await second.completion).status).toBe('completed');
      expect(toolsPerCall[2]).toEqual(['Read', 'Write']);
      expect(systems[2]).not.toContain('当前权限: Plan');
    } finally {
      db.close();
    }
  });

  it('fork 同轮共享完整父前缀, 第二轮重新分叉, 占位不写父 SQL', async () => {
    let releaseParent!: () => void;
    const parentRelease = new Promise<void>(resolve => { releaseParent = resolve; });
    let bothStarted!: () => void;
    const started = new Promise<void>(resolve => { bothStarted = resolve; });
    let startedCount = 0;
    let parentCalls = 0;
    const children: (readonly Message[])[] = [];
    const parents: (readonly Message[])[] = [];
    const llm: CallLlm = async function* (request) {
      const last = request.messages.at(-1)!;
      if (last.role === 'user' && typeof last.content === 'string'
          && last.content.includes('本次委派任务:')) {
        children.push(request.messages);
        yield { type: 'text_delta', blockIndex: 0, delta: '子任务已完成' };
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      parentCalls += 1;
      parents.push(request.messages);
      if (parentCalls === 1) {
        yield { type: 'thinking_delta', blockIndex: 0, delta: '父推理' };
        yield { type: 'tool_use_complete', blockIndex: 1, callId: 'fork-a', name: 'Subagent',
          args: { prompt: '查接口', description: '接口调查', role: 'general', contextMode: 'fork' } };
        yield { type: 'tool_use_complete', blockIndex: 2, callId: 'fork-b', name: 'Subagent',
          args: { prompt: '查测试', description: '测试调查', role: 'general', contextMode: 'fork' } };
        await parentRelease;
        yield { type: 'text_delta', blockIndex: 3, delta: '同一条 Assistant 的尾部' };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      if (parentCalls === 2) {
        yield { type: 'tool_use_complete', blockIndex: 0, callId: 'fork-c', name: 'Subagent',
          args: { prompt: '第三个任务', description: '后续调查', role: 'general', contextMode: 'fork' } };
        yield { type: 'text_delta', blockIndex: 1, delta: '第二轮父尾部' };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', blockIndex: 0, delta: '父最终结论' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    const fixture = forkFixture(llm, () => {
      startedCount += 1;
      if (startedCount === 2) bothStarted();
    });
    const handle = fixture.executor.start(makeStart(fixture.session.id));
    try {
      await started;
      expect(children).toHaveLength(0);
      releaseParent();
      expect((await handle.completion).status).toBe('completed');
      expect(children).toHaveLength(3);
      expect(children[0]!.slice(0, -1)).toEqual(children[1]!.slice(0, -1));
      expect(children[0]!.filter(message => message.role === 'system'))
        .toEqual(parents[0]!.filter(message => message.role === 'system'));
      const assistant = children[0]!.filter(message => message.role === 'assistant').at(-1)!;
      expect(assistant.generatedBy).toEqual({ providerId: 'p', modelId: 'm', protocol: 'openai-chat' });
      expect(assistant.content).toEqual([
        expect.objectContaining({ type: 'thinking', thinking: '父推理' }),
        expect.objectContaining({ type: 'tool_use', id: 'fork-a' }),
        expect.objectContaining({ type: 'tool_use', id: 'fork-b' }),
        { type: 'text', text: '同一条 Assistant 的尾部' },
      ]);
      expect(JSON.stringify(children[0])).not.toContain('第二轮父尾部');
      expect(JSON.stringify(children[2])).toContain('第二轮父尾部');
      expect(JSON.stringify(children[2])).toContain('子任务已完成');
      expect(JSON.stringify(children)).not.toContain('父最终结论');
      expect(JSON.stringify(fixture.sessions.loadMessagesForTurn(handle.turnId)))
        .not.toContain('Its result is not available in this fork');
      expect(fixture.store.listForSession(fixture.session.id).map(child => child.status))
        .toEqual(['completed', 'completed', 'completed']);
    } finally {
      releaseParent();
      await handle.completion;
      await fixture.subagents.waitForTurnSubagents(handle.turnId);
      fixture.db.close();
    }
  });

  it('fork 等待父 Assistant 时取消, 不等父流结束也能退出且不调用子模型', async () => {
    let releaseParent!: () => void;
    const parentRelease = new Promise<void>(resolve => { releaseParent = resolve; });
    let started!: (id: string) => void;
    const childStarted = new Promise<string>(resolve => { started = resolve; });
    let calls = 0;
    const llm: CallLlm = async function* () {
      calls += 1;
      if (calls === 1) {
        yield { type: 'tool_use_complete', blockIndex: 0, callId: 'fork-a', name: 'Subagent',
          args: { prompt: '后台调查', description: '后台调查', role: 'general', contextMode: 'fork', runInBackground: true } };
        await parentRelease;
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', blockIndex: 0, delta: '父继续完成' };
        yield { type: 'done', stopReason: 'end_turn' };
      }
    };
    const fixture = forkFixture(llm, started);
    const handle = fixture.executor.start(makeStart(fixture.session.id));
    try {
      const id = await childStarted;
      expect(fixture.executor.abortSubagent(handle.turnId, id)).toBe(true);
      await fixture.subagents.waitForTurnSubagents(handle.turnId);
      expect(fixture.store.get(id)!.status).toBe('cancelled');
      expect(calls).toBe(1);
      releaseParent();
      expect((await handle.completion).status).toBe('completed');
      expect(calls).toBe(2);
    } finally {
      releaseParent();
      await handle.completion;
      await fixture.subagents.waitForTurnSubagents(handle.turnId);
      fixture.db.close();
    }
  });

  it('fork 发起后父模型断流, 等待者结束并落终态, 不启动子模型', async () => {
    let started!: () => void;
    const childStarted = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const llm: CallLlm = async function* () {
      calls += 1;
      yield { type: 'tool_use_complete', blockIndex: 0, callId: 'fork-a', name: 'Subagent',
        args: { prompt: '后台调查', description: '后台调查', role: 'general', contextMode: 'fork', runInBackground: true } };
      await childStarted;
      throw new Error('父模型断流');
    };
    const fixture = forkFixture(llm, () => started());
    const handle = fixture.executor.start(makeStart(fixture.session.id));
    try {
      expect((await handle.completion).status).toBe('failed');
      await fixture.subagents.waitForTurnSubagents(handle.turnId);
      const children = fixture.store.listForSession(fixture.session.id);
      expect(children).toHaveLength(1);
      expect(children[0]!.status).toBe('failed');
      expect(calls).toBe(1);
    } finally {
      await handle.completion;
      await fixture.subagents.waitForTurnSubagents(handle.turnId);
      fixture.db.close();
    }
  });

  it('文本轮：completed 终态、用户与 assistant 消息落库、turn_completed 事件', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    const llm = scriptedLlm([
      [
        { type: 'usage', inputTokens: 120, outputTokens: 0, cacheReadInputTokens: 80 },
        { type: 'text_delta', blockIndex: 0, delta: '你好，' },
        { type: 'text_delta', blockIndex: 0, delta: '我是 Ema。' },
        { type: 'usage', inputTokens: 120, outputTokens: 12, cacheReadInputTokens: 80 },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const records: UsageRecord[] = [];
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      usageRecorder: {
        record: (record: UsageRecord) => records.push(record),
        finish: (record: UsageRecord) => {
          const index = records.findIndex(current => current.id === record.id);
          if (index < 0) throw new Error(`usage record ${record.id} does not exist`);
          records[index] = record;
        },
      },
    };
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    const outcome = await handle.completion;

    expect(outcome.status).toBe('completed');
    const messages = sessions.loadMessagesForTurn(handle.turnId);
    // 每 Turn 的消息序列：reminder（本 Turn 初始背景）→ 用户输入 → assistant 回复。
    expect(messages.map(m => `${m.role}:${m.kind}`)).toEqual([
      'user:reminder',
      'user:normal',
      'assistant:normal',
    ]);
    expect(JSON.stringify(messages[2]!.blocks)).toContain('你好，我是 Ema。');

    const events: TurnStreamEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.map(event => event.type)).toContain('turn_started');
    expect(events.find(event => event.type === 'turn_started')).toMatchObject({
      type: 'turn_started',
      triggerType: 'userMessage',
      ttsEnabled: true,
    });
    expect(events.filter(event => event.type === 'user_message_stored')).toEqual([
      { type: 'user_message_stored', message: messages[1] },
    ]);
    expect(events.map(event => event.type)).toContain('output_text_delta');
    for (const event of events) {
      if (event.type === 'agent_iteration' || event.type === 'output_text_delta') {
        expect(event.assistantMessageId).toBe(messages[2]!.id);
      }
    }
    expect(events.map(event => event.type)).toContain('turn_completed');
    const contextEvents = events.filter(event => event.type === 'context_usage_updated');
    expect(contextEvents.map(event => event.usage.source)).toEqual([
      'estimate',
      'provider',
      'provider',
      'estimate',
    ]);
    expect(new Set(contextEvents.map(event => event.llmCallId)).size).toBe(1);
    expect(contextEvents.at(-1)!.usage.inputTokens).toBeGreaterThan(120);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: contextEvents[0]!.llmCallId,
      sessionId: session.id,
      turnId: handle.turnId,
      status: 'completed',
      inputTokens: 120,
      outputTokens: 12,
      cacheReadInputTokens: 80,
    });
    expect(deps.turns.getTurn(handle.turnId)?.iterations).toBe(1);
    db.close();
  });

  it('reminder：事实在 Turn 开始一次持久化并回放进请求，先于用户输入且不重复', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    const requests: unknown[] = [];
    const llm: CallLlm = request => {
      requests.push(request.messages);
      return (async function* () {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '好。' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
    };
    const reminderCharacterNames: string[] = [];
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      readTurnReminder: (scope: { characterName: string }) => {
        reminderCharacterNames.push(scope.characterName);
        return {
          currentDate: '2026-08-25',
          goal: null,
          memoryWork: '用户在做 EmaAgent',
          taskReminder: '还有 2 个任务待处理',
        };
      },
    };
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    const outcome = await handle.completion;
    expect(outcome.status).toBe('completed');
    expect(reminderCharacterNames).toEqual(['test-character']);
    expect(deps.turns.getTurn(handle.turnId)?.characterName).toBe('test-character');

    // 持久化顺序：reminder 行在用户消息之前，facts 内容进 reminder。
    const messages = sessions.loadMessagesForTurn(handle.turnId);
    expect(messages[0]!.kind).toBe('reminder');
    const reminderBlocks = JSON.stringify(messages[0]!.blocks);
    expect(reminderBlocks).toContain('本 Turn 开始时的状态');
    expect(reminderBlocks).toContain('用户在做 EmaAgent');
    expect(reminderBlocks).toContain('还有 2 个任务待处理');

    // 首个 LLM 请求：reminder 回放出现在用户输入之前，且全文只出现一次。
    const first = JSON.stringify(requests[0]);
    expect(first.indexOf('用户在做 EmaAgent')).toBeGreaterThan(-1);
    expect(first.indexOf('用户在做 EmaAgent')).toBeLessThan(first.indexOf('你好'));
    expect(first.indexOf('用户在做 EmaAgent')).toBe(first.lastIndexOf('用户在做 EmaAgent'));
    db.close();
  });

  it('每根 Turn 持久化当前 Goal 与反馈, 关闭后的新 reminder 撤销旧历史目标', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    try {
      const sessions = new SessionStore({ db });
      const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
      const goals = new GoalStore(db);
      const created = goals.create(session.id, '整理 8 个 README');
      const goal = goals.reportFeedback({
        sessionId: session.id, goalId: created.id, expectedVersion: created.version,
      }, '已整理 2/8');
      const requests: Array<readonly Message[]> = [];
      const llm: CallLlm = request => {
        requests.push(request.messages);
        return (async function* () {
          yield { type: 'text_delta' as const, blockIndex: 0, delta: '已处理本轮工作。' };
          yield { type: 'done' as const, stopReason: 'end_turn' as const };
        })();
      };
      const readTurnReminder = vi.fn(() => ({
        currentDate: '2026-09-29', goal: goals.getCurrent(session.id),
      }));
      const executor = new TurnExecutor({
        ...makeDeps({ db, llm, sessionId: session.id, registry: new ToolRegistry() }),
        goalStore: goals,
        readTurnReminder,
      });
      const first = executor.start(makeStart(session.id));
      expect((await first.completion).status).toBe('completed');
      expect(JSON.stringify(requests[0])).toContain('已整理 2/8');
      expect(sessions.loadMessagesForTurn(first.turnId)[0]?.blocks).toContain(goal.id);
      goals.cancel({ sessionId: session.id, goalId: goal.id, expectedVersion: goal.version });
      const second = executor.start(makeStart(session.id));
      expect((await second.completion).status).toBe('completed');
      const latestReminder = sessions.loadMessagesForTurn(second.turnId)[0]!;
      expect(latestReminder.kind).toBe('reminder');
      expect(latestReminder.blocks).toContain('当前没有激活的 Goal');
      const secondRequest = JSON.stringify(requests[1]);
      expect(secondRequest.indexOf('当前没有激活的 Goal')).toBeGreaterThan(secondRequest.indexOf('整理 8 个 README'));
      expect(readTurnReminder).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('舞台清洗：表现标签剥离后落库与发射，emotion/motion 事件随流发出', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    const llm = scriptedLlm([
      [
        { type: 'text_delta', blockIndex: 0, delta: '你好<emotion>happy</emotion>，' },
        { type: 'text_delta', blockIndex: 0, delta: '我是 Ema。<motion>wave</motion><emotion>angry</emotion>' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const stage = new StageEngine({ emotions: ['happy'], motions: ['wave'] });
    const deps = { ...makeDeps({ db, llm, sessionId: session.id, registry }), stage };
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    const outcome = await handle.completion;

    expect(outcome.status).toBe('completed');
    const messages = sessions.loadMessagesForTurn(handle.turnId);
    const text = JSON.stringify(messages[2]!.blocks);
    expect(text).toContain('你好，我是 Ema。');
    expect(text).not.toContain('<emotion>');
    expect(text).not.toContain('<motion>');

    const types: string[] = [];
    for await (const event of handle.events) types.push(event.type);
    expect(types).toContain('emotion_changed');
    expect(types).toContain('motion_changed');
    // angry 不在当前角色词汇表：只清洗，不发事件。
    expect(types.filter(t => t === 'emotion_changed')).toHaveLength(1);
    db.close();
  });

  it('图片附件只存引用；当前 Turn 与后续历史都复用同一 Vision 描述', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    const requests: unknown[] = [];
    const llm: CallLlm = request => {
      requests.push(request.messages);
      return (async function* () {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '收到。' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
    };
    const imageBlock = {
      type: 'image_reference' as const,
      path: '/managed/cat.png',
      name: 'cat.png',
    };
    const reminderTexts: string[] = [];
    const describeImage = vi.fn(async () => '一只戴帽子的猫');
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      attachments: {
        attach: async (_s: string, _t: string, blocks: readonly unknown[]) => blocks,
      } as unknown as AttachmentStore,
      visionCache: {
        getOrCreate: (
          _path: string,
          _signal: AbortSignal,
          produce: (p: string, s: AbortSignal) => Promise<string>,
        ) => produce(_path, _signal),
      },
      describeImage,
      readTurnReminder: (scope: { userText: string }) => {
        reminderTexts.push(scope.userText);
        return { currentDate: '2026-08-25', goal: null };
      },
    };
    const executor = new TurnExecutor(deps);

    const first = executor.start({
      ...makeStart(session.id),
      input: [{ type: 'attachment', block: imageBlock }],
    });
    await first.completion;
    const firstMessages = sessions.loadMessagesForTurn(first.turnId);
    expect(firstMessages[1]!.blocks).toEqual([imageBlock]);

    const second = executor.start(makeStart(session.id));
    await second.completion;

    expect(JSON.stringify(requests[0])).toContain('一只戴帽子的猫');
    expect(JSON.stringify(requests[1])).toContain('一只戴帽子的猫');
    expect(JSON.stringify(requests[1])).not.toContain('正文未重复载入');
    expect(reminderTexts).toEqual(['', '你好']);
    db.close();
  });

  it('工具轮：tool_use 先落库、tool_result 后落库、最终 completed', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const llm = scriptedLlm([
      [
        { type: 'tool_use_complete', blockIndex: 0, callId: 'c1', name: 'Echo', args: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', blockIndex: 0, delta: '查到了。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const guidedInputs = [
      {
        id: 'guided-b',
        sessionId: session.id,
        input: [{ type: 'text' as const, text: '先引导 B' }],
        createdAt: 1,
        delivery: 'next_iteration' as const,
      },
      {
        id: 'guided-a',
        sessionId: session.id,
        input: [{ type: 'text' as const, text: '再引导 A' }],
        createdAt: 2,
        delivery: 'next_iteration' as const,
      },
    ];
    let guidedIndex = 0;
    const acknowledge = vi.fn();
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      continuations: {
        acknowledge,
        claimNextIteration: (_sessionId: string, turnId: string) => {
          const userInput = guidedInputs[guidedIndex++];
          if (!userInput) return undefined;
          return {
            type: 'user_input' as const,
            turnId,
            userInput,
          };
        },
        release: () => undefined,
        turnFinished: () => undefined,
      } as never,
    };
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    const outcome = await handle.completion;

    expect(outcome.status).toBe('completed');
    const messages = sessions.loadMessagesForTurn(handle.turnId);
    const kinds = messages.map(m => `${m.role}:${m.kind ?? 'normal'}`);
    expect(kinds).toEqual([
      'user:reminder',
      'user:normal',
      'assistant:normal',
      'user:tool_results',
      'user:normal',
      'user:normal',
      'assistant:normal',
    ]);
    expect(JSON.stringify(messages[2]!.blocks)).toContain('Echo');
    expect(JSON.stringify(messages[3]!.blocks)).toContain('echo-ok');
    const events: TurnStreamEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(events.filter(event => event.type === 'agent_iteration').map(event => event.assistantMessageId))
      .toEqual([messages[2]!.id, messages[6]!.id]);
    expect(events.find(event => event.type === 'tool_call_complete')).toMatchObject({
      assistantMessageId: messages[2]!.id,
      callId: 'c1',
    });
    expect(events.find(event => event.type === 'output_text_delta')).toMatchObject({
      assistantMessageId: messages[6]!.id,
      delta: '查到了。',
    });
    expect(events.filter(event => event.type === 'tool_result')).toEqual([{
      type: 'tool_result',
      sessionId: session.id,
      callId: 'c1',
      name: 'Echo',
      output: { kind: 'echo_result', value: 'echo-ok' },
      durationMs: expect.any(Number),
    }]);
    expect(events
      .filter(event => event.type === 'user_message_stored')
      .map(event => event.message.blocks))
      .toEqual(['你好', '先引导 B', '再引导 A']);
    expect(deps.turns.getTurn(handle.turnId)?.iterations).toBe(2);
    // 初始用户输入确认一次，两条 guided 各自在落库后确认一次.
    expect(acknowledge).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('工具结果落库后的下一次 Macro 可以覆盖本 Turn 消息, 游标指向真实 ToolResult', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const requests: unknown[] = [];
    const scripted = scriptedLlm([
      [
        { type: 'tool_use_complete', blockIndex: 0, callId: 'c1', name: 'Echo', args: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', blockIndex: 0, delta: '压缩后继续回答。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const llm: CallLlm = request => {
      requests.push(request.messages);
      return scripted(request);
    };
    let prepareCount = 0;
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      createCompact: () => async (request: Parameters<ReturnType<TurnExecutorDeps['createCompact']>>[0]) => {
        prepareCount += 1;
        if (prepareCount === 1) return { kind: 'unchanged' as const, messages: request.messages };
        request.saveMacroSummary?.('本轮工具结果摘要', request.messages.length, 80);
        return {
          kind: 'macro' as const,
          messages: [{ role: 'user' as const, content: '本轮工具结果摘要' }],
          summarizedMessageCount: request.messages.length,
          beforeTokens: 100,
          afterTokens: 20,
          savedTokens: 80,
          durationMs: 1,
        };
      },
    };

    const handle = new TurnExecutor(deps).start(makeStart(session.id));
    expect((await handle.completion).status).toBe('completed');

    const stored = sessions.loadMessagesForTurn(handle.turnId);
    const toolResult = stored.find(message => message.kind === 'tool_results');
    const summary = stored.find(message => message.kind === 'summary');
    expect(toolResult).toBeDefined();
    expect(summary).toBeDefined();
    const summaryRow = db.sqlite.prepare(
      'SELECT summarized_through_message_id FROM messages WHERE id = ?',
    ).get(summary!.id) as { summarized_through_message_id: string };
    expect(summaryRow.summarized_through_message_id).toBe(toolResult?.id);
    expect(sessions.loadHistory(session.id).map(message => message.id))
      .toEqual([summary?.id, stored.at(-1)?.id]);
    expect(JSON.stringify(requests[1])).toContain('本轮工具结果摘要');
    db.close();
  });

  it('续写提示没有 SQL 行时, Macro 游标落在已保存的 Assistant 上', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const llm = scriptedLlm([
      [
        { type: 'text_delta', blockIndex: 0, delta: '未完待续' },
        { type: 'done', stopReason: 'max_tokens' },
      ],
      [
        { type: 'text_delta', blockIndex: 0, delta: '后续回答' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    let prepareCount = 0;
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry: new ToolRegistry() }),
      createCompact: () => async (request: Parameters<ReturnType<TurnExecutorDeps['createCompact']>>[0]) => {
        prepareCount += 1;
        if (prepareCount === 1) return { kind: 'unchanged' as const, messages: request.messages };
        request.saveMacroSummary?.('续写前摘要', request.messages.length, 80);
        return {
          kind: 'macro' as const,
          messages: [{ role: 'user' as const, content: '续写前摘要' }],
          summarizedMessageCount: request.messages.length,
          beforeTokens: 100,
          afterTokens: 20,
          savedTokens: 80,
          durationMs: 1,
        };
      },
    };

    const handle = new TurnExecutor(deps).start(makeStart(session.id));
    expect((await handle.completion).status).toBe('completed');

    const stored = sessions.loadMessagesForTurn(handle.turnId);
    const firstAssistant = stored.find(message => message.role === 'assistant');
    const summary = stored.find(message => message.kind === 'summary');
    const summaryRow = db.sqlite.prepare(
      'SELECT summarized_through_message_id FROM messages WHERE id = ?',
    ).get(summary!.id) as { summarized_through_message_id: string };
    expect(summaryRow.summarized_through_message_id).toBe(firstAssistant?.id);
    expect(stored.map(message => message.kind))
      .toEqual(['reminder', 'normal', 'normal', 'summary', 'normal']);
    db.close();
  });

  it('第二条 guided 准备失败时只释放第二条, 第一条不重复交付', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'p', modelId: 'm' });
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const llm = scriptedLlm([[
      { type: 'tool_use_complete', blockIndex: 0, callId: 'c1', name: 'Echo', args: {} },
      { type: 'done', stopReason: 'tool_use' },
    ]]);
    const guidedInputs = [
      {
        id: 'guided-first',
        sessionId: session.id,
        input: [{ type: 'text' as const, text: '已经成功的第一条' }],
        createdAt: 1,
        delivery: 'next_iteration' as const,
      },
      {
        id: 'guided-second',
        sessionId: session.id,
        input: [{
          type: 'attachment' as const,
          block: { type: 'file_reference' as const, path: 'missing.txt' },
        }],
        createdAt: 2,
        delivery: 'next_iteration' as const,
      },
    ];
    const operations: string[] = [];
    let nextInput = 0;
    let claimedInputId: string | undefined;
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      attachments: {
        attach: async () => { throw new Error('附件不可用'); },
        getMany: () => new Map(),
      } as unknown as AttachmentStore,
      continuations: {
        acknowledge: () => {
          if (!claimedInputId) return;
          operations.push(`ack:${claimedInputId}`);
          claimedInputId = undefined;
        },
        claimNextIteration: (_sessionId: string, turnId: string) => {
          const userInput = guidedInputs[nextInput++];
          if (!userInput) return undefined;
          claimedInputId = userInput.id;
          return { type: 'user_input' as const, turnId, userInput };
        },
        release: () => {
          if (!claimedInputId) return;
          operations.push(`release:${claimedInputId}`);
          claimedInputId = undefined;
        },
        turnFinished: () => undefined,
      } as never,
    };

    const handle = new TurnExecutor(deps).start(makeStart(session.id));
    const outcome = await handle.completion;

    expect(outcome.status).toBe('failed');
    expect(operations).toEqual([
      'ack:guided-first',
      'release:guided-second',
    ]);
    expect(sessions.loadMessagesForTurn(handle.turnId)
      .filter(message => message.role === 'user' && message.kind === 'normal')
      .map(message => message.blocks))
      .toEqual(['你好', '已经成功的第一条']);
    db.close();
  });
});
