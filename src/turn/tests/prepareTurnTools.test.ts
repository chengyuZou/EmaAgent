// 测试 Turn 冻结工具池的 Plan 收窄, 权限交互回路和子代理事件顺序.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SubagentExecutor, SubagentStore, SubagentMessagesStore } from '@ema-agent/agent';
import { Database, SubagentsRepo, SubagentRunsRepo, SubagentMessagesRepo } from '@ema-agent/storage';
import { getSessionAllowRules, type PermissionStreamEvent } from '@ema-agent/permission';
import type { SettingsStore } from '@ema-agent/settings';
import {
  buildTool,
  BuiltinTools,
  contextOk,
  ToolRegistry,
  type ToolUseContext,
} from '@ema-agent/tools';
import { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';
import {
  prepareTurnTools,
  type TurnToolsDeps,
} from '../prepare/prepareTurnTools.js';

const SESSION_ID = 's1';
const TURN_ID = 't1';

function fakeSettings(): SettingsStore {
  const values = new Map<string, unknown>();
  return {
    get: (def: { key: string; defaultValue: unknown }) =>
      values.has(def.key) ? values.get(def.key) : def.defaultValue,
    set: (def: { key: string }, value: unknown) => { values.set(def.key, value); },
  } as unknown as SettingsStore;
}

function fakeTool(name: string, options: {
  id?: string;
  askWithSuggestion?: boolean;
} = {}) {
  return buildTool({
    ...(options.id ? { id: options.id } : {}),
    name,
    description: name,
    inputSchema: z.object({}),
    validateContext: () => contextOk({}),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkPermissions: async () => options.askWithSuggestion
      ? {
          behavior: 'ask' as const,
          message: '需要确认',
          ruleSuggestion: { toolName: name },
        }
      : { behavior: 'allow' as const },
    execute: async () => 'ok',
  });
}

function makeDeps(options: {
  tools: ReturnType<typeof fakeTool>[];
  queue: SessionInteractionQueue;
  settings: SettingsStore;
}): TurnToolsDeps {
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  return {
    registry,
    interactionQueue: options.queue,
    publishInteraction: () => undefined,
    settings: options.settings,
    subagents: {} as unknown as SubagentExecutor,
  };
}

function makeInput(options: {
  events: TurnStreamEvent[];
  overrides?: Partial<Parameters<typeof prepareTurnTools>[1]>;
}) {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sessionMode: 'work' as const,
    narrativePolicy: 'off' as const,
    cwd: '/w',
    workspaceRoots: ['/w'],
    prepareSubagent: async () => { throw new Error('不应派生子 Agent'); },
    reasoningEffort: 'high' as const,
    providerId: 'p',
    modelId: 'm',
    emit: (event: TurnStreamEvent) => { options.events.push(event); },
    permission: {
      mode: 'default' as const,
      buckets: { alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
    },
    signal: new AbortController().signal,
    ...(options.overrides ?? {}),
  };
}

describe('prepareTurnTools', () => {
  it.each(['foreground', 'background', 'shutdown', 'session_deleted'] as const)(
    '真实子代理批准等待的生命周期(%s)', async mode => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    db.sqlite.prepare("INSERT INTO sessions (id,title,cwd,created_at,updated_at) VALUES ('s1','测试','',1,1)").run();
    const store = new SubagentStore(db.sqlite, new SubagentsRepo(db.sqlite), new SubagentRunsRepo(db.sqlite));
    const queue = new SessionInteractionQueue(null);
    const events: PermissionStreamEvent[] = [];
    const parent = new AbortController();
    const onRunFinished = vi.fn((runId: string) => { queue.cancelForRun(runId); });
    const subagents = new SubagentExecutor({
      store, messageStore: new SubagentMessagesStore(new SubagentMessagesRepo(db.sqlite)),
      maxConcurrent: () => 4, publish: vi.fn(), onBackgroundCompleted: vi.fn(),
      onTerminalResultRead: vi.fn(), onRunFinished,
    });
    const assembly = prepareTurnTools({
      ...makeDeps({ tools: [fakeTool('Echo', { askWithSuggestion: true })], queue, settings: fakeSettings() }),
      subagents, publishInteraction: event => { events.push(event); },
    }, makeInput({ events: [], overrides: { signal: parent.signal } }));
    let calls = 0;
    let actualRunId = '';
    try {
      const { subagentId: id } = subagents.start({
        sessionId: SESSION_ID, parentTurnId: TURN_ID, toolCallId: 'parent-call', prompt: '委派任务',
        options: { title: '测试子代理', description: '批准等待', contextMode: 'subagent' },
        permissionMode: 'default', reasoningEffort: 'high', parentSignal: parent.signal,
        runInBackground: false,
        prepareSubagent: async ({ subagentId, runId, messageStore, signal }) => {
          actualRunId = runId;
          messageStore.initialize(subagentId, runId, '委派任务');
          return {
            messages: [{ role: 'user', content: '委派任务' }],
            prepareIteration: async ({ messages }) => ({ messages, request: { messages } }),
            callLlm: async function* () {
              if (calls++ === 0) {
                yield { type: 'tool_use_complete', blockIndex: 0, callId: 'child-call', name: 'Echo', args: {} };
                yield { type: 'done', stopReason: 'tool_use' };
              } else {
                yield { type: 'text_delta', blockIndex: 0, delta: '完成' };
                yield { type: 'done', stopReason: 'end_turn' };
              }
            },
            createToolExecutor: wake => assembly.createSubagentExecutor({
              subagentId, runId, toolPool: assembly.toolPool, signal, wake,
            }),
            signal, maxIterations: 2,
            generationSource: { providerId: 'p', modelId: 'm', protocol: 'openai-llm' },
          };
        },
      });
      await vi.waitFor(() => expect(queue.size()).toBe(1));
      const pending = queue.listPending(SESSION_ID)[0]!;
      expect(pending.request).toMatchObject({ subagentId: id, runId: actualRunId, toolCallId: 'child-call' });
      if (mode === 'background') {
        subagents.moveToBackground(id, SESSION_ID);
        await assembly.shutdown('parent completed');
        parent.abort();
        expect(queue.cancelForTurn(TURN_ID)).toBe(0);
        expect(queue.listPending(SESSION_ID)).toEqual([pending]);
        expect(events.filter(event => event.type === 'permission_required')).toHaveLength(1);
        const result = subagents.awaitResult(id, SESSION_ID, new AbortController().signal);
        expect(queue.respondPermission(SESSION_ID, 'child-call', { action: 'allow' })).toBe(true);
        await expect(result).resolves.toMatchObject({ output: '完成' });
        expect(store.getRun(actualRunId)?.status).toBe('completed');
      } else if (mode === 'foreground') {
        const result = subagents.waitForInitialResult(id, SESSION_ID, new AbortController().signal);
        parent.abort(new Error('parent stopped'));
        await expect(result).rejects.toThrow();
        expect(store.getRun(actualRunId)?.status).toBe('cancelled');
      } else {
        subagents.moveToBackground(id, SESSION_ID);
        const result = subagents.awaitResult(id, SESSION_ID, new AbortController().signal);
        const rejected = expect(result).rejects.toThrow();
        if (mode === 'shutdown') await subagents.shutdown('application stopped');
        else await subagents.abortForSession(SESSION_ID);
        await rejected;
        expect(store.getRun(actualRunId)?.status).toBe('cancelled');
      }
      expect(queue.size()).toBe(0);
      expect(onRunFinished).toHaveBeenCalledTimes(1);
      expect(onRunFinished).toHaveBeenCalledWith(actualRunId);
    } finally {
      await subagents.shutdown('test ended');
      queue.cancelForSession(SESSION_ID);
      db.close();
    }
  });

  it('根与两个子代理共用 FIFO, 父 Turn 停止后子代理仍可批准原工具', async () => {
    const events: PermissionStreamEvent[] = [];
    const turnEvents: TurnStreamEvent[] = [];
    const queue = new SessionInteractionQueue(null);
    const parent = new AbortController();
    const childController = new AbortController();
    const otherController = new AbortController();
    const assembly = prepareTurnTools({
      ...makeDeps({ tools: [fakeTool('Echo', { askWithSuggestion: true })], queue, settings: fakeSettings() }),
      publishInteraction: event => { events.push(event); },
    }, makeInput({ events: turnEvents, overrides: { signal: parent.signal } }));
    const root = assembly.createExecutor(() => undefined);
    const child = assembly.createSubagentExecutor({
      subagentId: 'agent-1', runId: 'run-1', toolPool: assembly.toolPool,
      signal: childController.signal, wake: () => undefined,
    });
    const other = assembly.createSubagentExecutor({
      subagentId: 'agent-2', runId: 'run-2', toolPool: assembly.toolPool,
      signal: otherController.signal, wake: () => undefined,
    });
    root.addTool(0, 'root-call', 'Echo', {});
    await vi.waitFor(() => expect(queue.size()).toBe(1));
    child.addTool(0, 'child-call', 'Echo', {});
    await vi.waitFor(() => expect(queue.size()).toBe(2));
    other.addTool(0, 'other-call', 'Echo', {});
    await vi.waitFor(() => expect(queue.size()).toBe(3));
    expect(queue.listPending(SESSION_ID).map(entry => entry.request.toolCallId))
      .toEqual(['root-call', 'child-call', 'other-call']);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_required', sessionId: SESSION_ID, turnId: TURN_ID,
      toolCallId: 'child-call', subagentId: 'agent-1', runId: 'run-1',
    }));
    expect(turnEvents).toEqual([]);

    parent.abort();
    queue.cancelForTurn(TURN_ID);
    await root.join();
    expect(root.takeCompletedResults()[0]).toMatchObject({ errorCode: 'tool/cancelled' });
    expect(queue.size()).toBe(2);
    expect(queue.respondPermission(SESSION_ID, 'other-call', { action: 'allow' })).toBe(false);
    expect(queue.respondPermission(SESSION_ID, 'child-call', { action: 'allow' })).toBe(true);
    await child.join();
    expect(child.takeCompletedResults()[0]).toMatchObject({ toolCallId: 'child-call', isError: false });
    otherController.abort();
    await other.join();
    expect(other.takeCompletedResults()[0]).toMatchObject({ errorCode: 'tool/cancelled' });
    expect(queue.size()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_resolved', subagentId: 'agent-1', runId: 'run-1', decision: 'allow',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission_resolved', subagentId: 'agent-2', runId: 'run-2', decision: 'deny',
    }));
  });

  it('Shell 工厂使用本 Turn 冻结的工作目录与授权目录', () => {
    const received: Array<{ cwd: string; roots: readonly string[] }> = [];
    const deps: TurnToolsDeps = {
      ...makeDeps({
        tools: [],
        queue: new SessionInteractionQueue(null),
        settings: fakeSettings(),
      }),
      commandRunner: (cwd, roots) => {
        received.push({ cwd, roots });
        return undefined;
      },
    };

    prepareTurnTools(deps, makeInput({
      events: [],
      overrides: { cwd: '/old', workspaceRoots: ['/current'] },
    }));

    expect(received).toEqual([{ cwd: '/old', roots: ['/current'] }]);
  });

  it('Chat 和 Work 都保留宿主可用工具, 只读限制由 Plan 权限决定', () => {
    const readTool = fakeTool('Read', { id: BuiltinTools.FileRead.id });
    const skillTool = fakeTool('Skill', { id: BuiltinTools.Skill.id });
    const bashTool = fakeTool('Bash', { id: BuiltinTools.Bash.id });
    const deps = makeDeps({
      tools: [readTool, skillTool, bashTool],
      queue: new SessionInteractionQueue(null),
      settings: fakeSettings(),
    });

    const chat = prepareTurnTools(deps, makeInput({ events: [], overrides: { sessionMode: 'chat' } }));
    expect(chat.toolPool.get('Read')).toBeDefined();
    expect(chat.toolPool.get('Skill')).toBeDefined();
    expect(chat.toolPool.get('Bash')).toBeDefined();

    const work = prepareTurnTools(deps, makeInput({ events: [] }));
    expect(work.toolPool.get('Bash')).toBeDefined();
  });

  it.each(['chat', 'work'] as const)('Plan 在 %s 中只保留指定只读工具, 执行器无法重新找到写工具', async sessionMode => {
    const tools = Object.values(BuiltinTools).map(identity =>
      fakeTool(identity.name, { id: identity.id }));
    // 即使工具自称只读, 也不能用任意名字或 MCP 声明扩入 Plan 池.
    tools.push(fakeTool('mcp__demo__read', { id: 'mcp:demo:read' }));
    const deps = makeDeps({ tools, queue: new SessionInteractionQueue(null), settings: fakeSettings() });
    const assembly = prepareTurnTools(deps, makeInput({
      events: [],
      overrides: {
        sessionMode,
        permission: {
          mode: 'plan',
          buckets: { alwaysAllowRules: { session: ['Write', 'Bash'] }, alwaysDenyRules: {}, alwaysAskRules: {} },
        },
      },
    }));
    expect(assembly.toolPool.tools.map(tool => tool.name).sort()).toEqual([
      'Read', 'PdfRead', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ProcessList', 'ProcessOutput',
      'TaskGet', 'TaskList', 'KnowledgeBaseSearch', 'NarrativeSearch', 'MemorySearch', 'MemoryRead',
      'MemoryList', 'Skill', 'ScratchpadRead', 'ScratchpadList',
    ].sort());

    const executor = assembly.createExecutor(() => undefined);
    executor.addTool(0, 'read-1', 'Read', {});
    executor.addTool(1, 'write-1', 'Write', {});
    executor.addTool(2, 'shell-1', 'Bash', {});
    await executor.join();
    expect(executor.takeCompletedResults()).toMatchObject([
      { toolCallId: 'read-1', isError: false },
      { toolCallId: 'write-1', isError: true, errorCode: 'tool/unavailable' },
      { toolCallId: 'shell-1', isError: true, errorCode: 'tool/unavailable' },
    ]);
  });

  it('ask 决策经队列等用户；allowSession 沉淀 session 规则并发出 resolved', async () => {
    const events: PermissionStreamEvent[] = [];
    const queue = new SessionInteractionQueue(null);
    const settings = fakeSettings();
    const deps = makeDeps({
      tools: [fakeTool('Echo', { askWithSuggestion: true })],
      queue,
      settings,
    });
    const assembly = prepareTurnTools({
      ...deps,
      publishInteraction: event => {
        expect(queue.listPending(SESSION_ID)).toHaveLength(event.type === 'permission_required' ? 1 : 0);
        events.push(event);
      },
    }, makeInput({ events: [] }));
    const executor = assembly.createExecutor(() => undefined);
    executor.addTool(0, 'call-1', 'Echo', {});

    // 等权限卡发出后按"本 Session 允许"回答。
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission_required')).toBe(true);
    });
    expect(queue.respondPermission(SESSION_ID, 'call-1', { action: 'allowSession' })).toBe(true);
    await executor.join();

    const results = executor.takeCompletedResults();
    expect(results[0]).toMatchObject({ toolCallId: 'call-1', isError: false });
    expect(getSessionAllowRules(SESSION_ID)).toContain('Echo');
    expect(events.some(e => e.type === 'permission_resolved'
      && (e as { decision?: string }).decision === 'allow')).toBe(true);
  });

  it('子代理工具终态不抢在 transcript 落库前从 Turn 事件口发出', async () => {
    const events: TurnStreamEvent[] = [];
    const deps = makeDeps({
      tools: [fakeTool('Echo')],
      queue: new SessionInteractionQueue(null),
      settings: fakeSettings(),
    });
    const assembly = prepareTurnTools(deps, makeInput({ events }));
    const executor = assembly.createSubagentExecutor({
      subagentId: 'subagent-1',
      runId: 'run-1',
      toolPool: assembly.toolPool,
      signal: new AbortController().signal,
      wake: () => undefined,
    });

    executor.addTool(0, 'call-1', 'Echo', {});
    await executor.join();

    expect(executor.takeCompletedResults()).toMatchObject([{ toolCallId: 'call-1' }]);
    expect(events.some(event => event.type === 'tool_result')).toBe(false);
  });

  it('Turn abort 时等待中的权限询问按取消收口（模型见 tool/cancelled）', async () => {
    const queue = new SessionInteractionQueue(null);
    const controller = new AbortController();
    const deps = makeDeps({
      tools: [fakeTool('Echo', { askWithSuggestion: true })],
      queue,
      settings: fakeSettings(),
    });
    const assembly = prepareTurnTools(deps, makeInput({
      events: [],
      overrides: { signal: controller.signal },
    }));
    const executor = assembly.createExecutor(() => undefined);
    executor.addTool(0, 'call-1', 'Echo', {});

    await vi.waitFor(() => {
      expect(queue.listPending(SESSION_ID)).toHaveLength(1);
    });
    controller.abort();
    await executor.join();

    const results = executor.takeCompletedResults();
    expect(results[0]).toMatchObject({ isError: true, errorCode: 'tool/cancelled' });
  });

  it('Knowledge 查询冻结所选知识库，Tool 未指定文档时继承本 Turn 范围', async () => {
    const requests: unknown[] = [];
    let search: ToolUseContext['knowledgeSearch'];
    const probe = buildTool({
      name: 'KnowledgeProbe',
      description: '验证知识库能力传入工具',
      inputSchema: z.object({}),
      validateContext: (context: ToolUseContext) => {
        search = context.knowledgeSearch;
        return contextOk({});
      },
      checkPermissions: async () => ({ behavior: 'allow' as const }),
      execute: async () => 'ok',
    });
    const deps = {
      ...makeDeps({
        tools: [probe],
        queue: new SessionInteractionQueue(null),
        settings: fakeSettings(),
      }),
      knowledgeSearch: async (request: unknown) => {
        requests.push(request);
        return { query: 'q', hits: [] };
      },
    } as TurnToolsDeps;
    prepareTurnTools(deps, makeInput({
      events: [],
      overrides: {
        knowledge: { assetIds: ['asset-1'] },
      },
    }));

    await search?.({ query: 'first' });
    await search?.({ query: 'second', assetIds: ['asset-2'] });

    expect(requests).toEqual([
      { query: 'first', assetIds: ['asset-1'] },
      { query: 'second', assetIds: ['asset-2'] },
    ]);
  });
});
