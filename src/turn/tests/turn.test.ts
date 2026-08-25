// 集成测试：TurnExecutor 全链——文本轮完成、工具轮的持久化顺序与终态。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentRunMessagesStore, AgentRunStore } from '@ema-agent/agent';
import type { Attachment, AttachmentStore } from '@ema-agent/attachments';
import type { CallLlm, LlmStreamEvent } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { Database } from '@ema-agent/storage';
import { ActiveSessionRegistry, SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { StageEngine } from '@ema-agent/stage';
import {
  buildTool,
  contextOk,
  ToolRegistry,
} from '@ema-agent/tools';
import { SessionInteractionQueue } from '../interactionQueue.js';
import { TurnExecutor, type TurnExecutorDeps } from '../turn.js';
import { TurnStore } from '../turnStore.js';
import type { StartTurn } from '../types.js';

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
    execute: async () => 'echo-ok',
  });
}

function makeDeps(options: {
  db: Database;
  llm: CallLlm;
  sessionId: string;
  registry: ToolRegistry;
  titleStarter?: (sessionId: string, userText: string) => void;
}): TurnExecutorDeps {
  const { db, llm, sessionId, registry, titleStarter } = options;
  return {
    turns: new TurnStore({ db, activeSessions: new ActiveSessionRegistry() }),
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
    agentRunStore: {} as unknown as AgentRunStore,
    agentRunMessagesStore: {} as unknown as AgentRunMessagesStore,
    createCompact: () => async request => ({ kind: 'unchanged' as const, history: request.history }),
    readTurnReminder: () => ({ currentDate: '2026-08-25' }),
    characterDirectoryName: () => 'test-character',
    ...(titleStarter ? { startSessionTitleGeneration: titleStarter } : {}),
  };
}

function makeStart(sessionId: string): StartTurn {
  return {
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    input: [{ type: 'text', text: '你好' }],
    modelSelection: {
      providerId: 'p',
      modelId: 'm',
      thinkingEnabled: false,
      thinkingEffort: 'medium',
    },
  };
}

describe('TurnExecutor 集成', () => {
  it('文本轮：completed 终态、用户与 assistant 消息落库、turn_completed 事件', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ workspaceRoot: '/w' });
    const registry = new ToolRegistry();
    const llm = scriptedLlm([
      [
        { type: 'text_delta', blockIndex: 0, delta: '你好，' },
        { type: 'text_delta', blockIndex: 0, delta: '我是 Ema。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const deps = makeDeps({ db, llm, sessionId: session.id, registry });
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

    const events: string[] = [];
    for await (const event of handle.events) events.push(event.type);
    expect(events).toContain('turn_started');
    expect(events).toContain('output_text_delta');
    expect(events).toContain('turn_completed');
    db.close();
  });

  it('reminder：事实在 Turn 开始一次持久化并回放进请求，先于用户输入且不重复', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ workspaceRoot: '/w' });
    const registry = new ToolRegistry();
    const requests: unknown[] = [];
    const llm: CallLlm = request => {
      requests.push(request.messages);
      return (async function* () {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '好。' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
    };
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      readTurnReminder: () => ({
        currentDate: '2026-08-25',
        memoryWork: '用户在做 EmaAgent',
        taskReminder: '还有 2 个任务待处理',
      }),
    };
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    const outcome = await handle.completion;
    expect(outcome.status).toBe('completed');

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

  it('舞台清洗：表现标签剥离后落库与发射，emotion/motion 事件随流发出', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ workspaceRoot: '/w' });
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
    expect(types).toContain('stage_cue');
    // angry 不在当前角色词汇表：只清洗，不发事件。
    expect(types.filter(t => t === 'emotion_changed')).toHaveLength(1);
    db.close();
  });

  it('标题生成：userMessage 落库后即异步启动，非用户触发不启动', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ workspaceRoot: '/w' });
    const registry = new ToolRegistry();
    const llm = scriptedLlm([
      [
        { type: 'text_delta', blockIndex: 0, delta: '你好。' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const calls: Array<[string, string]> = [];
    const deps = makeDeps({
      db,
      llm,
      sessionId: session.id,
      registry,
      titleStarter: (sessionId, userText) => { calls.push([sessionId, userText]); },
    });
    const executor = new TurnExecutor(deps);

    const handle = executor.start(makeStart(session.id));
    await handle.completion;
    expect(calls).toEqual([[session.id, '你好']]);

    const second = executor.start({
      ...makeStart(session.id),
      triggerType: 'backgroundProcessCompleted',
    });
    await second.completion;
    expect(calls).toHaveLength(1);
    db.close();
  });

  it('图片附件只存引用；当前 Turn 与后续历史都复用同一 Vision 描述', async () => {
    const db = new Database({ memory: true, kind: 'data' });
    db.migrate();
    const sessions = new SessionStore({ db });
    const session = sessions.createSession({ workspaceRoot: '/w' });
    const registry = new ToolRegistry();
    const requests: unknown[] = [];
    const llm: CallLlm = request => {
      requests.push(request.messages);
      return (async function* () {
        yield { type: 'text_delta' as const, blockIndex: 0, delta: '收到。' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      })();
    };
    const image: Attachment = {
      id: 'att-image',
      turnId: 'fixture-turn',
      sessionId: session.id,
      kind: 'image',
      name: 'cat.png',
      mimeType: 'image/png',
      sourcePath: '/x/cat.png',
      sourceByteSize: 3,
      sourceModifiedAt: 1,
      imagePath: '/managed/cat.png',
      imageByteSize: 3,
      createdAt: 1,
    };
    const reminderTexts: string[] = [];
    const deps = {
      ...makeDeps({ db, llm, sessionId: session.id, registry }),
      attachments: {
        addAll: async (inputs: readonly unknown[]) => inputs.length > 0 ? [image] : [],
        getMany: (ids: readonly string[]) => new Map(
          ids.includes(image.id) ? [[image.id, image]] : [],
        ),
      } as unknown as AttachmentStore,
      describeImage: async () => '一只戴帽子的猫',
      readTurnReminder: (scope: { userText: string }) => {
        reminderTexts.push(scope.userText);
        return { currentDate: '2026-08-25' };
      },
    };
    const executor = new TurnExecutor(deps);

    const first = executor.start({
      ...makeStart(session.id),
      input: [{ type: 'attachment', attachment: { sourcePath: '/x/cat.png' } }],
    });
    await first.completion;
    const firstMessages = sessions.loadMessagesForTurn(first.turnId);
    expect(firstMessages[1]!.blocks).toEqual([{
      type: 'attachment_ref',
      attachmentId: image.id,
      name: image.name,
      mimeType: image.mimeType,
    }]);

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
    const session = sessions.createSession({ workspaceRoot: '/w' });
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
    const deps = makeDeps({ db, llm, sessionId: session.id, registry });
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
      'assistant:normal',
    ]);
    expect(JSON.stringify(messages[2]!.blocks)).toContain('Echo');
    expect(JSON.stringify(messages[3]!.blocks)).toContain('echo-ok');
    db.close();
  });
});
