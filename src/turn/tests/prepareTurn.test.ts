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
import { FileStateCache, ToolRegistry } from '@ema-agent/tools';
import type { Turn } from '@ema-agent/turn';
import { SessionInteractionQueue } from '../interactionQueue.js';
import { TurnPreparationError } from '../errors.js';
import {
  prepareTurn,
  type PrepareTurnDeps,
} from '../prepare/prepareTurn.js';
import type { StartTurn } from '../types.js';
import { TurnExecutor } from '../turn.js';
import { TurnStore } from '../turnStore.js';
import { SessionContinuationQueue } from '../sessionContinuationQueue.js';

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
    skillEntries: () => [],
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
    const callLlm = vi.fn(async function* () {
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
      createLlmCall: () => callLlm,
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
      expect(callLlm).not.toHaveBeenCalled();
      expect(turns.getTurn(handle.turnId)?.status).toBe('aborted');
      expect(running.isRunning(session.id)).toBe(false);
      expect(deps.subagents.abortForegroundForTurn).toHaveBeenCalledWith(handle.turnId);
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
    expect(prepared.systemPrompt.find(block => block.name === 'character')?.content)
      .toContain('你是角色');
    expect(prepared.systemPrompt.find(block => block.name === 'permission-mode')?.content)
      .toContain('当前权限: Plan');
  });

  it('将 Session 的 projectId 交给技能目录装载，并按项目文件夹冻结授权目录', async () => {
    const requested: Array<[string, string | null]> = [];
    const runnerDirectories: Array<[string, readonly string[]]> = [];
    await prepareTurn(
      makeDeps({
        skillEntries: async (cwd, projectId) => {
          requested.push([cwd, projectId]);
          return [];
        },
        commandRunner: (cwd, workspaceRoots) => {
          runnerDirectories.push([cwd, workspaceRoots]);
          return undefined;
        },
      }),
      makeRuntime(makeStart()),
    );

    expect(requested).toEqual([['/w', 'p1']]);
    expect(runnerDirectories).toEqual([['/w', ['/w']]]);
  });

  it('项目全部源文件夹进入 Prompt，而工作区指令仍从 Session cwd 读取', async () => {
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
    const environment = prepared.systemPrompt.find(block => block.name === 'runtime-environment')!;

    expect(instructionDirectories).toEqual(['/w']);
    expect(environment.content).toContain('当前执行目录(cwd): /w');
    expect(environment.content).toContain('项目源文件夹：\n  - /w\n  - /other');
    expect(prepared.systemPrompt.find(block => block.name === 'workspace-instructions')?.content)
      .toContain('主目录约定');
  });

  it('Session 未指定模型时准备失败（provider/not_configured）', async () => {
    const deps = makeDeps({
      sessions: {
        getSession: () => fakeSession({ providerId: null, modelId: null }),
        listProjectFolders: () => [],
      } as never,
    });
    await expect(prepareTurn(deps, makeRuntime(makeStart()))).rejects.toThrow(TurnPreparationError);
  });

  it('从 Session 冻结模型与推理强度，模型未启用时报错', async () => {
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
    // resolveConnection().protocol 在 prepare 时冻结为实际调用协议。
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
    const deps = makeDeps({ skillEntries: () => [descriptor] });

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

  it('根 Turn 提供 Scratchpad 并冻结统一迭代上限, 修改设置影响下一次准备', async () => {
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

  it('选择不存在或被禁用的 Skill 直接准备失败；合法 Skill 只冻结引用', async () => {
    const descriptor: SkillDescriptor = {
      name: 'demo',
      path: '/skills/demo/SKILL.md',
      version: '1.0.0',
      description: 'd',
      scope: 'user',
    };
    let attachmentWrites = 0;
    const deps = makeDeps({
      skillEntries: () => [descriptor],
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
