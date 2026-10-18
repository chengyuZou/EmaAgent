import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { maxIterationsSetting } from '@ema-agent/agent';
import type { SubagentExecutor } from '@ema-agent/agent';
import type { AttachmentStore } from '@ema-agent/attachments';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import { Database } from '@ema-agent/storage';
import type { SettingsStore } from '@ema-agent/settings';
import type { SkillDescriptor } from '@ema-agent/skills';
import { buildTool, BuiltinTools, contextOk, FileStateCache, ToolRegistry } from '@ema-agent/tools';
import type { CallLLM, Message } from '@ema-agent/llm';
import { z } from 'zod';
import type { Turn } from '@ema-agent/turn';
import { SessionInteractionQueue } from '../interactionQueue.js';
import { TurnPreparationError } from '../errors.js';
import {
  prepareTurn,
  type PrepareTurnDeps,
} from '../prepare/prepareTurn.js';
import type { StartTurn, TurnHandle } from '../types.js';
import type { TurnStreamEvent } from '../events.js';
import { TurnExecutor } from '../turn.js';
import { TurnStore } from '../turnStore.js';
import { SessionContinuationQueue, type SessionContinuationEvent } from '../sessionContinuationQueue.js';
import { prepareContextInput } from '../prepare/prepareContextInput.js';

const TURN: Turn = {
  id: 't1',
  sessionId: 's1',
  status: 'running',
  triggerType: 'userMessage',
  ttsEnabled: false,
  providerId: null,
  modelId: null,
  protocol: null,
  characterName: null,
  iterations: 0,
  createdAt: 1,
  completedAt: null,
  errorCode: null,
  errorMessage: null,
};

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    cwd: '/w',
    projectId: 'p1',
    providerId: 'sess-p',
    modelId: 'sess-m',
    reasoningEffort: 'off',
    permissionMode: 'default',
    ttsEnabled: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PrepareTurnDeps> = {}): PrepareTurnDeps {
  const settingsValues = new Map<string, unknown>();
  const cache = new FileStateCache();
  return {
    sessions: {
      getSession: () => fakeSession(),
      listProjectFolders: () => [{ path: '/w' }],
    } as unknown as Pick<SessionStore, 'getSession' | 'listProjectFolders'>,
    providers: {
      resolveConnection: () => ({ protocol: 'openai-chat', baseUrl: 'http://localhost', apiKey: 'k' }),
    } as unknown as Providers,
    providerModels: {
      get: () => ({
        providerId: 'sess-p',
        capability: 'llm',
        modelId: 'sess-m',
        contextWindow: 200_000,
        maxOutput: null,
        toolCall: true,
        reasoning: null,
        temperature: null,
        inputImage: true,
      }),
    } as unknown as ProviderModels,
    attachments: {
      attach: async (_sessionId: string, _turnId: string, blocks: readonly unknown[]) => blocks,
    } as unknown as AttachmentStore,
    settings: {
      get: (def: { key: string; defaultValue: unknown }) =>
        settingsValues.has(def.key) ? settingsValues.get(def.key) : def.defaultValue,
      set: (def: { key: string }, value: unknown) => { settingsValues.set(def.key, value); },
    } as unknown as SettingsStore,
    characterPrompt: () => ['你是角色'],
    skillEntries: async () => [],
    disabledSkillPaths: () => [],
    registry: new ToolRegistry(),
    fileStateCache: () => cache,
    interactionQueue: new SessionInteractionQueue(null),
    publishInteraction: () => undefined,
    subagents: {
      abortForegroundForTurn: vi.fn(async () => undefined),
    } as unknown as SubagentExecutor,
    ...overrides,
  };
}

function makeStart(overrides: Partial<StartTurn> = {}): StartTurn {
  return {
    sessionId: 's1',
    triggerType: 'userMessage',
    ttsEnabled: false,
    input: [{ type: 'text', text: '你好' }],
    ...overrides,
  };
}

function makeRuntime(start: StartTurn) {
  return {
    request: start,
    turnId: TURN.id,
    prepareSubagent: async () => { throw new Error('不应派生子 Agent'); },
    emit: () => undefined,
    signal: new AbortController().signal,
  };
}

describe('prepareTurn', () => {
  it('空闲估算与实际 Turn 共用 Prompt 和工具列表, 但不创建执行资源', async () => {
    const deps = makeDeps();
    const validateContext = vi.fn(() => contextOk({}));
    deps.registry.register(buildTool({
      name: 'Probe', description: '探针工具', inputSchema: z.object({}), validateContext,
      isReadOnly: () => true, isConcurrencySafe: () => true,
      checkPermissions: async () => ({ behavior: 'allow' as const }), execute: async () => 'ok',
    }));
    const createLLMCall = vi.fn(() => vi.fn() as unknown as CallLLM);
    const scratchpadDirForTurn = vi.fn(() => '/scratchpad');
    const configured = { ...deps, createLLMCall, scratchpadDirForTurn };
    const preview = await prepareContextInput(configured, 's1', new AbortController().signal);
    expect(createLLMCall).not.toHaveBeenCalled();
    expect(scratchpadDirForTurn).not.toHaveBeenCalled();
    expect(validateContext).not.toHaveBeenCalled();
    const actual = await prepareTurn(configured, makeRuntime(makeStart()));
    expect(actual.systemPrompt).toEqual(preview.systemPrompt);
    expect(actual.tools.toolPool.tools).toEqual(preview.toolPool.tools);
    expect(validateContext).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'aborted'] as const)('整批保存与长工具期间引导, %s 只处理仍未保存的排队输入', async ending => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const running = new SessionRunningRegistry();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'sess-p', modelId: 'sess-m' });
    const turns = new TurnStore({ db, sessionRunning: running });
    const handles: TurnHandle[] = [];
    const events: TurnStreamEvent[] = [];
    const queueEvents: SessionContinuationEvent[] = [];
    const requests: Array<readonly Message[]> = [];
    let releaseTool!: () => void;
    const toolWaiting = new Promise<void>(resolve => { releaseTool = resolve; });
    let releaseReply!: () => void;
    const replyWaiting = new Promise<void>(resolve => { releaseReply = resolve; });
    let toolStarted = false;
    const registry = new ToolRegistry();
    registry.register(buildTool({
      name: 'WaitingTool', description: '受控的未完成工具',
      inputSchema: z.object({}),
      validateContext: () => contextOk({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      checkPermissions: async () => ({ behavior: 'allow' }),
      execute: async () => {
        toolStarted = true;
        await toolWaiting;
        return '工具完成';
      },
    }));
    const callLLM: CallLLM = async function* (request) {
      requests.push([...request.messages]);
      if (requests.length === 1) {
        yield { type: 'tool_use_complete', blockIndex: 0, callId: 'waiting-call', name: 'WaitingTool', args: {} };
        yield { type: 'done', stopReason: 'tool_use' };
        return;
      }
      if (requests.length === 2) {
        await replyWaiting;
        request.signal?.throwIfAborted();
        if (ending === 'failed') throw new Error('测试失败');
      }
      yield { type: 'text_delta', blockIndex: 0, delta: '完成' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
    let executor: TurnExecutor;
    const queue = new SessionContinuationQueue({
      sessions, sessionRunning: running, goals: { getCurrent: () => null },
      startTurn: input => {
        const handle = executor.start(input);
        handles.push(handle);
        return handle;
      },
      attachTurn: handle => {
        void (async () => {
          for await (const event of handle.events) events.push(event);
        })();
      },
      publish: (_id, event) => queueEvents.push(event),
    });
    executor = new TurnExecutor({
      ...makeDeps({ sessions, registry, createLLMCall: () => callLLM }),
      sessions, turns, continuations: queue,
      readTurnReminder: () => ({ currentDate: '2026-10-15', goal: null }),
      characterName: () => 'test',
      hasNormalUserMessage: () => false,
      createCompact: () => async request => ({ kind: 'unchanged', messages: request.messages }),
    });
    try {
      const a = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: 'A' }] });
      const a2 = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: '补充 A' }] });
      await vi.waitFor(() => expect(toolStarted).toBe(true));
      expect(sessions.loadMessagesForTurn(handles[0]!.turnId).filter(message => message.kind === 'normal' && message.role === 'user'))
        .toMatchObject([{ blocks: 'A\n\n补充 A' }]);
      expect(events.find(event => event.type === 'user_message_stored'))
        .toMatchObject({ queuedInputIds: [a.id, a2.id] });

      const b = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: 'B' }] });
      const c = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: 'C' }] });
      const d = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: 'D' }] });
      queue.guide(session.id, d.id);
      queue.guide(session.id, c.id);
      expect(queueEvents.filter(event => event.type === 'queued_input_guided')).toHaveLength(2);
      expect(events.filter(event => event.type === 'user_message_stored')).toHaveLength(1);
      expect(requests).toHaveLength(1);

      releaseTool();
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const messages = sessions.loadMessagesForTurn(handles[0]!.turnId);
      const guidedIndex = messages.findIndex(message => message.blocks === 'C\n\nD');
      expect(guidedIndex).toBeGreaterThan(messages.findIndex(message => message.kind === 'tool_results'));
      expect(events.filter(event => event.type === 'user_message_stored'))
        .toMatchObject([{ queuedInputIds: [a.id, a2.id] }, { queuedInputIds: [c.id, d.id] }]);

      const e = queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: 'E' }] });
      if (ending === 'aborted') handles[0]!.abort();
      releaseReply();
      expect(await handles[0]!.completion).toMatchObject({ status: ending });
      if (ending === 'completed') {
        await vi.waitFor(() => expect(handles).toHaveLength(2));
        await handles[1]!.completion;
        expect(sessions.loadMessagesForTurn(handles[1]!.turnId).filter(message => message.kind === 'normal' && message.role === 'user'))
          .toMatchObject([{ blocks: 'B\n\nE' }]);
        expect(queueEvents.some(event => event.type === 'queued_inputs_returned')).toBe(false);
      } else {
        expect(handles).toHaveLength(1);
        expect(queueEvents.at(-1)).toEqual({ type: 'queued_inputs_returned', items: [b, e] });
      }
      expect(queue.list(session.id)).toEqual([]);
      expect(sessions.loadMessagesForTurn(handles[0]!.turnId).some(message => message.blocks === 'C\n\nD')).toBe(true);
    } finally {
      queue.shutdown();
      releaseTool();
      releaseReply();
      for (const handle of handles) handle.abort();
      await Promise.all(handles.map(handle => handle.completion));
      db.close();
    }
  });

  it.each(['attachment', 'reminder'] as const)('等待 %s 时归档, 返回后不保存未交付输入或调用模型', async waitingFor => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const running = new SessionRunningRegistry();
    const sessions = new SessionStore({ db, isWorkClosed: id => running.isClosed(id) });
    const session = sessions.createSession({ cwd: os.tmpdir(), providerId: 'sess-p', modelId: 'sess-m' });
    const turns = new TurnStore({ db, sessionRunning: running });
    const queue = new SessionContinuationQueue({
      sessions,
      sessionRunning: running,
      goals: { getCurrent: () => null },
      startTurn: () => { throw new Error('停止后不应启动后继 Turn'); },
      attachTurn: vi.fn(),
      publish: vi.fn(),
    });
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const preparation = new Promise<void>(resolve => { release = resolve; });
    const callLLM = vi.fn(async function* () {
      throw new Error('停止后不应调用模型');
    });
    const readTurnReminder = vi.fn(async () => {
      if (waitingFor === 'reminder') {
        entered();
        await preparation;
      }
      return { currentDate: '2026-10-11', goal: null };
    });
    const deps = makeDeps({
      sessions,
      createLLMCall: () => callLLM,
      attachments: {
        attach: async (_sessionId: string, _turnId: string, blocks: readonly unknown[]) => {
          if (waitingFor === 'attachment') {
            entered();
            await preparation;
          }
          return blocks;
        },
      } as unknown as AttachmentStore,
    });
    const executor = new TurnExecutor({
      ...deps,
      sessions,
      turns,
      continuations: queue,
      readTurnReminder,
      characterName: () => 'test',
      hasNormalUserMessage: () => false,
      createCompact: () => async () => { throw new Error('停止后不应压缩'); },
    });
    const handle = executor.start(makeStart({
      sessionId: session.id,
      input: [{ type: 'attachment', block: { type: 'file_reference', path: '/pending.txt' } }],
    }));
    try {
      await ready;
      queue.enqueue({ sessionId: session.id, input: [{ type: 'text', text: '未保存排队输入' }] });
      const stopping = running.runWithSessionClosed(session.id, async () => {
        sessions.archiveSession(session.id);
        queue.clearSession(session.id);
        await handle.completion;
      });
      release();
      await stopping;
      expect(await handle.completion).toMatchObject({ status: 'aborted' });
      expect(sessions.loadHistory(session.id)).toEqual([]);
      expect(queue.list(session.id)).toEqual([]);
      expect(callLLM).not.toHaveBeenCalled();
      expect(turns.getTurn(handle.turnId)?.status).toBe('aborted');
      expect(running.isRunning(session.id)).toBe(false);
      if (waitingFor === 'attachment') expect(readTurnReminder).not.toHaveBeenCalled();
    } finally {
      release();
      handle.abort();
      await handle.completion;
      queue.shutdown();
      db.close();
    }
  });

  it('Session 的 Plan 权限进入本轮 Prompt, 角色仍保留', async () => {
    const prepared = await prepareTurn(
      makeDeps({ sessions: {
        getSession: () => fakeSession({ permissionMode: 'plan' }),
        listProjectFolders: () => [],
      } as never }),
      makeRuntime(makeStart()),
    );
    expect(prepared.systemPrompt.find(block => block.content.includes('你是角色'))?.content)
      .toContain('你是角色');
    expect(prepared.systemPrompt.find(block => block.content.startsWith('# 当前权限:'))?.content)
      .toContain('当前权限: Plan');
  });

  it('将 Session 的 projectId 交给技能目录装载,并按项目文件夹冻结授权目录', async () => {
    const requested: Array<[string, string | null]> = [];
    const runnerDirectories: Array<[string, readonly string[]]> = [];
    const registry = new ToolRegistry();
    registry.register(buildTool({
      id: BuiltinTools.Bash.id,
      name: BuiltinTools.Bash.name,
      description: 'Bash',
      inputSchema: z.object({}),
      validateContext: () => contextOk({}),
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      checkPermissions: async () => ({ behavior: 'allow' }),
      execute: async () => 'ok',
    }));
    await prepareTurn(
      makeDeps({
        registry,
        skillEntries: async (cwd, projectId) => {
          requested.push([cwd, projectId]);
          return [];
        },
        commandRunner: async (cwd, workspaceRoots) => {
          runnerDirectories.push([cwd, workspaceRoots]);
          return undefined;
        },
      }),
      makeRuntime(makeStart()),
    );

    expect(requested).toEqual([['/w', 'p1']]);
    expect(runnerDirectories).toEqual([['/w', ['/w']]]);
  });

  it('项目全部源文件夹进入 Prompt,而工作区指令仍从 Session cwd 读取', async () => {
    const instructionDirectories: string[] = [];
    const prepared = await prepareTurn(
      makeDeps({
        sessions: {
          getSession: () => fakeSession(),
          listProjectFolders: () => [{ path: '/w' }, { path: '/other' }],
        } as never,
        workspaceInstructions: cwd => {
          instructionDirectories.push(cwd);
          return '主目录约定';
        },
      }),
      makeRuntime(makeStart()),
    );
    const environment = prepared.systemPrompt.find(block => block.content.startsWith('# 本轮运行环境'))!;

    expect(instructionDirectories).toEqual(['/w']);
    expect(environment.content).toContain('当前执行目录(cwd): /w');
    expect(environment.content).toContain('项目源文件夹:\n  - /w\n  - /other');
    expect(prepared.systemPrompt.find(block => block.content.startsWith('# 工作区指令'))?.content)
      .toContain('主目录约定');
  });

  it('Session 未指定模型时准备失败(provider/not_configured)', async () => {
    const deps = makeDeps({
      sessions: {
        getSession: () => fakeSession({ providerId: null, modelId: null }),
        listProjectFolders: () => [],
      } as never,
    });
    await expect(prepareTurn(deps, makeRuntime(makeStart()))).rejects.toThrow(TurnPreparationError);
  });

  it('从 Session 冻结模型与推理强度,模型未启用时报错', async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      providers: {
        resolveConnection: (providerId: string) => {
          seen.push(providerId);
          return { protocol: 'openai-chat', baseUrl: 'http://localhost' };
        },
      } as unknown as Providers,
      sessions: {
        getSession: () => fakeSession({ providerId: 'req-p', modelId: 'req-m', reasoningEffort: 'high' }),
        listProjectFolders: () => [],
      } as never,
      providerModels: {
        get: (providerId: string, capability: string, modelId: string) =>
          providerId === 'req-p' && modelId === 'req-m'
            ? { capability: 'llm', contextWindow: 128_000, inputImage: false, reasoning: true }
            : undefined,
      } as unknown as ProviderModels,
    });

    const prepared = await prepareTurn(deps, makeRuntime(makeStart()));
    expect(prepared.providerId).toBe('req-p');
    expect(prepared.contextWindow).toBe(128_000);
    expect(prepared.supportsImageInput).toBe(false);
    // resolveConnection().protocol 在 prepare 时冻结为实际调用协议.
    expect(prepared.protocol).toBe('openai-chat');
    expect(prepared.thinking).toEqual({ enabled: true, effort: 'high' });
    expect(seen).toEqual(['req-p']);

    const disabled = makeDeps({
      sessions: {
        getSession: () => fakeSession({ providerId: 'disabled-p', modelId: 'disabled-m' }),
        listProjectFolders: () => [],
      } as never,
      providerModels: deps.providerModels,
    });
    await expect(prepareTurn(disabled, makeRuntime(makeStart()))).rejects.toThrow(/未在该 Provider 下启用/);
  });

  it('冻结 SkillPool 并接受已选 Skill, 未选择时仍提供目录', async () => {
    const descriptor: SkillDescriptor = {
      name: 'demo',
      path: '/skills/demo/SKILL.md',
      version: '1.0.0',
      description: 'd',
      scope: 'user',
    };
    const deps = makeDeps({ skillEntries: async () => [descriptor] });

    const selected = await prepareTurn(deps, makeRuntime(makeStart({
      input: [{ type: 'skill_reference', name: 'demo', path: descriptor.path }],
    })));
    expect(selected.skillPool?.getByPath(descriptor.path)).toBeDefined();
    expect(selected.userMessageBlocks).toEqual([{
      type: 'skill_reference',
      name: 'demo',
      path: descriptor.path,
    }]);

    const unselected = await prepareTurn(deps, makeRuntime(makeStart()));
    expect(unselected.skillPool?.getByPath('/skills/demo/SKILL.md')).toBeDefined();
  });

  it('Turn 提供 Scratchpad 并冻结统一迭代上限, 修改设置影响下一次准备', async () => {
    const directories: Array<[string, string]> = [];
    const deps = makeDeps({
      scratchpadDirForTurn: (sessionId, turnId) => {
        directories.push([sessionId, turnId]);
        return '/scratchpad';
      },
    });
    const first = await prepareTurn(deps, makeRuntime(makeStart()));
    expect(first.maxIterations).toBe(50);
    expect(first.scratchpadDir).toBe('/scratchpad');
    expect(directories).toEqual([['s1', 't1']]);

    deps.settings.set(maxIterationsSetting, 80);
    const next = await prepareTurn(deps, makeRuntime(makeStart()));
    expect(first.maxIterations).toBe(50);
    expect(next.maxIterations).toBe(80);
  });

  it('迭代上限接受 30-100 的整数, 默认 50 且下一轮生效', () => {
    expect(maxIterationsSetting.defaultValue).toBe(50);
    expect(maxIterationsSetting.apply).toBe('nextTurn');
    for (const value of [30, 50, 100]) {
      expect(maxIterationsSetting.schema.safeParse(value).success).toBe(true);
    }
    for (const value of [29, 101, 50.5, '50']) {
      expect(maxIterationsSetting.schema.safeParse(value).success).toBe(false);
    }
  });

  it('选择不存在或被禁用的 Skill 直接准备失败;合法 Skill 只冻结引用', async () => {
    const descriptor: SkillDescriptor = {
      name: 'demo',
      path: '/skills/demo/SKILL.md',
      version: '1.0.0',
      description: 'd',
      scope: 'user',
    };
    let attachmentWrites = 0;
    const deps = makeDeps({
      skillEntries: async () => [descriptor],
      attachments: {
        attach: async () => {
          attachmentWrites += 1;
          return [];
        },
      } as unknown as AttachmentStore,
    });

    await expect(prepareTurn(deps, makeRuntime(makeStart({
      input: [
        { type: 'attachment', block: { type: 'file_reference', path: '/x.txt' } },
        { type: 'skill_reference', name: 'ghost', path: '/skills/ghost/SKILL.md' },
      ],
    }))))
      .rejects.toThrow(/不存在或已被禁用/);
    expect(attachmentWrites).toBe(0);

    const prepared = await prepareTurn(deps, makeRuntime(makeStart({
      input: [
        { type: 'text', text: '请使用 ' },
        { type: 'skill_reference', name: 'demo', path: '/skills/demo/SKILL.md' },
        { type: 'text', text: ' 处理它' },
      ],
    })));
    expect(prepared.userMessageBlocks).toEqual([
      { type: 'text', text: '请使用 ' },
      {
        type: 'skill_reference',
        name: 'demo',
        path: '/skills/demo/SKILL.md',
      },
      { type: 'text', text: ' 处理它' },
    ]);
  });

  it('附件登记失败映射为 turn/attachment_failed', async () => {
    const deps = makeDeps({
      attachments: {
        attach: async () => { throw new Error('附件账本缺少记录'); },
      } as unknown as AttachmentStore,
    });
    await expect(prepareTurn(deps, makeRuntime(makeStart({
      input: [{ type: 'attachment', block: { type: 'image_reference', path: '/x.png' } }],
    })))).rejects.toThrow(TurnPreparationError);
  });

  it('模型不支持图片且存在图片附件时记录降级通知', async () => {
    const imageBlock = {
      type: 'image_reference' as const,
      path: '/managed/a.png',
      name: 'a.png',
    };
    const deps = makeDeps({
      providerModels: {
        get: () => ({ capability: 'llm', contextWindow: 128_000, inputImage: false }),
      } as unknown as ProviderModels,
      attachments: {
        attach: async (_s: string, _t: string, blocks: readonly unknown[]) => blocks,
      } as unknown as AttachmentStore,
      describeImage: async () => '一只猫',
    });
    const prepared = await prepareTurn(deps, makeRuntime(makeStart({
      input: [{ type: 'attachment', block: imageBlock }],
    })));
    expect(prepared.degradations).toHaveLength(1);
    expect(prepared.degradations[0]).toMatchObject({ removed: ['image'] });
    expect(prepared.userMessageBlocks).toEqual([imageBlock]);
  });
});
