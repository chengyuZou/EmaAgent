// 测试 prepareTurnTools 的 Chat 白名单、权限交互回路（allowSession 沉淀）与 AskUser 回路。
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentRunMessagesStore, AgentRunStore } from '@ema-agent/agent';
import {
  getSessionAllowRules,
  type PermissionRequest,
  type PermissionResponse,
} from '@ema-agent/permission';
import type { SettingsStore } from '@ema-agent/settings';
import {
  buildTool,
  BuiltinTools,
  contextOk,
  ToolRegistry,
  type AskUserRequiredEvent,
} from '@ema-agent/tools';
import { SessionInteractionQueue } from '../interaction/sessionInteractionQueue.js';
import type { TurnStreamEvent } from '../events.js';
import {
  prepareTurnTools,
  type TurnToolsDeps,
} from '../preparation/prepareTurnTools.js';

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
  queue: SessionInteractionQueue<PermissionRequest, PermissionResponse, AskUserRequiredEvent>;
  settings: SettingsStore;
}): TurnToolsDeps {
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  return {
    registry,
    decisionQueue: options.queue,
    settings: options.settings,
    agentRunStore: {} as unknown as AgentRunStore,
    agentRunMessagesStore: {} as unknown as AgentRunMessagesStore,
  };
}

function makeInput(options: {
  events: TurnStreamEvent[];
  overrides?: Partial<Parameters<typeof prepareTurnTools>[1]>;
}) {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    executionProfile: 'work' as const,
    narrativePolicy: 'off' as const,
    workspaceRoot: '/w',
    budget: {
      assertWithinLimits: () => undefined,
      remainingOutputTokens: () => 1_000,
      recordUsage: () => undefined,
      reserveToolCall: () => undefined,
      enterSubagent: () => () => undefined,
    },
    prepareSubagent: async () => { throw new Error('不应派生子 Agent'); },
    parentMessages: [],
    model: { providerId: 'p', modelId: 'm' },
    emit: (event: TurnStreamEvent) => { options.events.push(event); },
    permission: {
      mode: 'default' as const,
      buckets: { alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
      isBypassPermissionsModeAvailable: false,
    },
    signal: new AbortController().signal,
    ...(options.overrides ?? {}),
  };
}

describe('prepareTurnTools', () => {
  it('chat Profile 只保留只读白名单工具；work 保留全部', () => {
    const readTool = fakeTool('Read', { id: BuiltinTools.FileRead.id });
    const bashTool = fakeTool('Bash', { id: BuiltinTools.Bash.id });
    const deps = makeDeps({
      tools: [readTool, bashTool],
      queue: new SessionInteractionQueue(null, reason => ({ action: 'deny', reason })),
      settings: fakeSettings(),
    });

    const chat = prepareTurnTools(deps, makeInput({ events: [], overrides: { executionProfile: 'chat' } }));
    expect(chat.toolPool.get('Read')).toBeDefined();
    expect(chat.toolPool.get('Bash')).toBeUndefined();

    const work = prepareTurnTools(deps, makeInput({ events: [] }));
    expect(work.toolPool.get('Bash')).toBeDefined();
  });

  it('ask 决策经队列等用户；allowSession 沉淀 session 规则并发出 resolved', async () => {
    const events: TurnStreamEvent[] = [];
    const queue = new SessionInteractionQueue<PermissionRequest, PermissionResponse, AskUserRequiredEvent>(
      null,
      reason => ({ action: 'deny', reason }),
    );
    const settings = fakeSettings();
    const deps = makeDeps({
      tools: [fakeTool('Echo', { askWithSuggestion: true })],
      queue,
      settings,
    });
    const assembly = prepareTurnTools(deps, makeInput({ events }));
    const executor = assembly.createExecutor(() => undefined);
    executor.addTool(0, 'call-1', 'Echo', {});
    executor.start();

    // 等权限卡发出后按"本 Session 允许"回答。
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission_required')).toBe(true);
    });
    expect(queue.respondPermission('call-1', { action: 'allowSession' })).toBe(true);
    await executor.join();

    const results = executor.takeCompletedResults();
    expect(results[0]).toMatchObject({ toolCallId: 'call-1', isError: false });
    expect(getSessionAllowRules(SESSION_ID)).toContain('Echo');
    expect(events.some(e => e.type === 'permission_resolved'
      && (e as { decision?: string }).decision === 'allow')).toBe(true);
  });

  it('Turn abort 时等待中的权限询问按取消收口（模型见 tool/cancelled）', async () => {
    const queue = new SessionInteractionQueue<PermissionRequest, PermissionResponse, AskUserRequiredEvent>(
      null,
      reason => ({ action: 'deny', reason }),
    );
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
    executor.start();

    await vi.waitFor(() => {
      expect(queue.listPending(SESSION_ID)).toHaveLength(1);
    });
    controller.abort();
    await executor.join();

    const results = executor.takeCompletedResults();
    expect(results[0]).toMatchObject({ isError: true, errorCode: 'tool/cancelled' });
  });
});
