// 集成测试：TurnExecutor 全链——文本轮完成、工具轮的持久化顺序与终态。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentRunMessagesStore, AgentRunStore } from '@ema-agent/agent';
import type { AttachmentStore } from '@ema-agent/attachments';
import type { LanguageModel, LlmStreamEvent } from '@ema-agent/llm';
import type { PermissionRequest, PermissionResponse } from '@ema-agent/permission';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { Database } from '@ema-agent/storage';
import { SessionStore } from '@ema-agent/session';
import type { SettingsStore } from '@ema-agent/settings';
import {
  buildTool,
  contextOk,
  ToolRegistry,
  type AskUserRequiredEvent,
} from '@ema-agent/tools';
import { SessionDecisionQueue } from '../interaction/decisionQueue.js';
import { TurnExecutor, type TurnExecutorDeps } from '../turn.js';
import { TurnStore } from '../turnStore.js';
import type { StartTurn } from '../types.js';

function scriptedLlm(calls: LlmStreamEvent[][]): LanguageModel {
  let index = 0;
  return {
    protocol: 'openai-chat',
    stream: async function* () {
      const events = calls[Math.min(index, calls.length - 1)]!;
      index += 1;
      for (const event of events) yield event;
    },
    complete: async () => { throw new Error('测试不走 complete'); },
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
  llm: LanguageModel;
  sessionId: string;
  registry: ToolRegistry;
}): TurnExecutorDeps {
  const { db, llm, sessionId, registry } = options;
  return {
    turns: new TurnStore({ db }),
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
    attachments: { addAll: async () => [] } as unknown as AttachmentStore,
    settings: fakeSettingsStore(),
    characterPrompt: () => ({ prompt: '你是测试角色', presentation: '' }),
    skillEntries: () => [],
    createLlm: () => llm,
    registry,
    decisionQueue: new SessionDecisionQueue<PermissionRequest, PermissionResponse, AskUserRequiredEvent>(
      null,
      reason => ({ action: 'deny', reason }),
    ),
    agentRunStore: {} as unknown as AgentRunStore,
    agentRunMessagesStore: {} as unknown as AgentRunMessagesStore,
    createCompact: () => async request => ({ kind: 'unchanged' as const, history: request.history }),
    reminderSources: {},
  };
}

function makeStart(sessionId: string): StartTurn {
  return {
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    userInput: '你好',
    providerId: 'p',
    modelId: 'm',
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
    const roles = messages.map(m => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(JSON.stringify(messages[1]!.blocks)).toContain('你好，我是 Ema。');

    const events: string[] = [];
    for await (const event of handle.events) events.push(event.type);
    expect(events).toContain('turn_started');
    expect(events).toContain('output_text_delta');
    expect(events).toContain('turn_completed');
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
      'user:normal',
      'assistant:normal',
      'user:tool_results',
      'assistant:normal',
    ]);
    expect(JSON.stringify(messages[1]!.blocks)).toContain('Echo');
    expect(JSON.stringify(messages[2]!.blocks)).toContain('echo-ok');
    db.close();
  });
});
