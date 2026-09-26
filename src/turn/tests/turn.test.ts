// 集成测试：TurnExecutor 全链——文本轮完成、工具轮的持久化顺序与终态。
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { z } from 'zod';
import type { SubagentExecutor } from '@ema-agent/agent';
import type { AttachmentStore } from '@ema-agent/attachments';
import type { CallLlm, LlmStreamEvent } from '@ema-agent/llm';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { Database } from '@ema-agent/storage';
import { SessionRunningRegistry, SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import { StageEngine } from '@ema-agent/stage';
import type { UsageRecord } from '@ema-agent/usage';
import {
  buildTool,
  contextOk,
  ToolRegistry,
} from '@ema-agent/tools';
import { SessionInteractionQueue } from '../interactionQueue.js';
import type { TurnStreamEvent } from '../events.js';
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
      turnCompleted: () => undefined,
    } as never,
    createCompact: () => async request => ({ kind: 'unchanged' as const, messages: request.messages }),
    readTurnReminder: () => ({ currentDate: '2026-08-25' }),
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

describe('TurnExecutor 集成', () => {
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
      usageRecorder: { record: (record: UsageRecord) => records.push(record) },
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
        return { currentDate: '2026-08-25' };
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
        turnCompleted: () => undefined,
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
        request.saveMacroSummary?.('本轮工具结果摘要', request.messages.length);
        return {
          kind: 'macro' as const,
          messages: [{ role: 'user' as const, content: '本轮工具结果摘要' }],
          summarizedMessageCount: request.messages.length,
          beforeTokens: 100,
          afterTokens: 20,
          savedTokens: 80,
          durationMs: 1,
          usage: { inputTokens: 10, outputTokens: 5 },
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
        request.saveMacroSummary?.('续写前摘要', request.messages.length);
        return {
          kind: 'macro' as const,
          messages: [{ role: 'user' as const, content: '续写前摘要' }],
          summarizedMessageCount: request.messages.length,
          beforeTokens: 100,
          afterTokens: 20,
          savedTokens: 80,
          durationMs: 1,
          usage: { inputTokens: 10, outputTokens: 5 },
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
        turnCompleted: () => undefined,
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
