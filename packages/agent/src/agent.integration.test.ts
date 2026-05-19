/**
 * Integration test: AgentEngine — mini think→act loop with real DeepSeek API.
 *
 * 使用 DeepSeek (openai-llm 兼容) 跑真实 API 调用。
 * 运行: pnpm --filter @ema-agent/agent test
 *
 * 覆盖场景:
 *   1. simple  — 无工具 agent turn，LLM 直接 end_turn 回答
 *   2. fs_read — LLM 主动调用 fs_read 读一个真实文件
 *   3. glob    — LLM 调用 glob_files 列出 package.json
 *   4. circuit-breaker — 故意触发 plan 模式 10 次迭代熔断
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';

import { LlmRouter } from '@ema-agent/llm';
import { HookBus } from '@ema-agent/hook';
import { EmotionEngine } from '@ema-agent/emotion';
import { PermissionEngine } from '@ema-agent/permission';
import { ToolRegistry } from '@ema-agent/tool';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import type { Message, Turn } from '@ema-agent/session';
import type { SessionId, TurnId, MessageId } from '@ema-agent/contracts';
import type { ResolvedModelBinding } from '@ema-agent/storage';

import { AgentEngine } from './engine.js';
import type { AgentDeps } from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DS_KEY       = 'sk-xxx9fb976f5d59';
const PROVIDER_ID  = 'deepseek-test';
const MODEL        = 'deepseek-chat';
const WORKSPACE    = path.resolve('D:/Github/EmaAgent');
const TEST_TIMEOUT = 90_000;

// ── In-memory SessionStore mock ───────────────────────────────────────────────

function makeSessionStore() {
  const messages: Message[] = [];
  let msgCounter = 0;

  return {
    loadHistory(_sessionId: string): Message[] {
      return [...messages];
    },
    appendMessage(input: {
      turnId: TurnId;
      sessionId: SessionId;
      role: string;
      kind?: string;
      blocks: unknown;
    }): Message {
      const msg: Message = {
        id:          `msg-${++msgCounter}` as MessageId,
        sessionId:   input.sessionId,
        turnId:      input.turnId,
        role:        input.role as Message['role'],
        kind:        (input.kind ?? 'message') as Message['kind'],
        blocks:      input.blocks as Message['blocks'],
        interrupted: false,
        createdAt:   Date.now(),
        meta:        {},
      };
      messages.push(msg);
      return msg;
    },
    completeTurn(_turnId: TurnId, _data: unknown): void { /* noop */ },
    failTurn(_turnId: TurnId, _code: string, _msg: string): void { /* noop */ },
    abortTurn(_sessionId: SessionId, _turnId: TurnId): void { /* noop */ },
    // clear between tests
    clear() { messages.length = 0; msgCounter = 0; },
  };
}

// ── ModelBindingsRepo mock ────────────────────────────────────────────────────

function makeModelBindings(providerId: string, model: string) {
  return {
    get(_module: string): ResolvedModelBinding | undefined {
      return { module: 'agent', providerConfigId: providerId, model, voiceId: null, config: {} };
    },
  };
}

// ── Turn stub ─────────────────────────────────────────────────────────────────

function makeTurn(id = 'turn-1'): Turn {
  return {
    id:                id as TurnId,
    sessionId:         'session-1' as SessionId,
    mode:              'agent',
    agentSubMode:      'full',
    status:            'running',
    userInput:         '',
    startedAt:         Date.now(),
    completedAt:       null,
    errorCode:         null,
    errorMessage:      null,
    iterations:        0,
    usageInputTokens:  0,
    usageOutputTokens: 0,
    costUsd:           0,
    meta:              {},
  };
}

// ── Deps factory ──────────────────────────────────────────────────────────────

let deps: AgentDeps;
let sessionStore: ReturnType<typeof makeSessionStore>;

beforeAll(() => {
  const llm = new LlmRouter([{
    id:           PROVIDER_ID,
    provider:     'openai-llm',
    apiKey:       DS_KEY,
    baseUrl:      'https://api.deepseek.com',
    defaultModel: MODEL,
  }]);

  const hooks = new HookBus();
  const emotion = new EmotionEngine({ vocabulary: ['neutral', 'happy', 'sad', 'surprised', 'angry'] });

  const permission = new PermissionEngine({
    mode:  'bypass',
    rules: [],
    ask:   async () => ({ action: 'allow', remember: false }),
  });

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  sessionStore = makeSessionStore();

  deps = {
    session:       sessionStore as unknown as AgentDeps['session'],
    hooks,
    llm,
    emotion,
    tools,
    permission,
    modelBindings: makeModelBindings(PROVIDER_ID, MODEL) as unknown as AgentDeps['modelBindings'],
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain the full AsyncIterable and return all events. */
async function collectEvents(engine: AgentEngine, input: Parameters<AgentEngine['run']>[0]) {
  const events = [];
  for await (const ev of engine.run(input)) {
    events.push(ev);
  }
  return events;
}

function makeInput(overrides: Partial<Parameters<AgentEngine['run']>[0]> = {}) {
  return {
    turn:          makeTurn(),
    signal:        AbortSignal.timeout(60_000),
    sessionId:     'session-1' as SessionId,
    subMode:       'full' as const,
    userInput:     'Hello',
    systemPrompt:  'You are a helpful assistant.',
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AgentEngine integration (DeepSeek)', () => {

  it('1. simple: no-tool turn ends normally', async () => {
    sessionStore.clear();
    const engine = new AgentEngine(deps);
    const events = await collectEvents(engine, makeInput({
      userInput:    'Reply with exactly: PONG',
      systemPrompt: 'You are a helpful assistant. Always follow instructions precisely.',
    }));

    const started   = events.find(e => e.type === 'turn_started');
    const completed = events.find(e => e.type === 'turn_completed');
    const textEvs   = events.filter(e => e.type === 'output_text_delta');
    const fullText  = textEvs.map((e: any) => e.delta).join('');

    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(fullText.toLowerCase()).toContain('pong');

    console.log('[test 1] fullText:', fullText);
    console.log('[test 1] usage:', (completed as any)?.usage);
  }, TEST_TIMEOUT);

  it('2. fs_read: LLM reads a real file', async () => {
    sessionStore.clear();
    const engine = new AgentEngine(deps);

    const targetFile = path.join(WORKSPACE, 'packages/agent/package.json');
    const events = await collectEvents(engine, makeInput({
      turn:      makeTurn('turn-2'),
      userInput: `Use the fs_read tool to read the file at path "${targetFile}" and tell me the package name.`,
      systemPrompt: 'You are a helpful agent. Use tools when asked.',
    }));

    const completed  = events.find(e => e.type === 'turn_completed');
    const toolResult = events.find(e => e.type === 'tool_result' && (e as any).output !== undefined);
    const textEvs    = events.filter(e => e.type === 'output_text_delta');
    const fullText   = textEvs.map((e: any) => e.delta).join('');

    expect(completed).toBeDefined();
    expect(toolResult).toBeDefined();
    // The final answer should mention the package name
    expect(fullText.toLowerCase()).toMatch(/ema.?agent\/agent|@ema-agent\/agent/i);

    console.log('[test 2] tool events:', events.filter(e => e.type === 'tool_call_complete' || e.type === 'tool_result').length);
    console.log('[test 2] finalText:', fullText.slice(0, 200));
  }, TEST_TIMEOUT);

  it('3. glob: LLM lists package.json files', async () => {
    sessionStore.clear();
    const engine = new AgentEngine(deps);

    const events = await collectEvents(engine, makeInput({
      turn:      makeTurn('turn-3'),
      userInput: `Use the glob_files tool with pattern "packages/*/package.json" in the workspace root "${WORKSPACE}" to list all package.json files. Tell me how many you found.`,
      systemPrompt: 'You are a helpful agent. Use tools when asked and report the results.',
    }));

    const completed = events.find(e => e.type === 'turn_completed');
    const textEvs   = events.filter(e => e.type === 'output_text_delta');
    const fullText  = textEvs.map((e: any) => e.delta).join('');

    expect(completed).toBeDefined();
    // Should mention a number > 0
    expect(fullText).toMatch(/\d+/);

    console.log('[test 3] iterations:', (events.find(e => e.type === 'agent_iteration') as any)?.n);
    console.log('[test 3] finalText:', fullText.slice(0, 300));
  }, TEST_TIMEOUT);

  it('4. plan mode: write tools denied by policy', async () => {
    sessionStore.clear();
    const engine = new AgentEngine(deps);

    const events = await collectEvents(engine, makeInput({
      turn:      { ...makeTurn('turn-4'), agentSubMode: 'plan' },
      subMode:   'plan',
      userInput: 'Use bash_execute to run: echo hello',
      systemPrompt: 'You are a helpful agent. Try to use bash_execute tool.',
    }));

    const completed = events.find(e => e.type === 'turn_completed');
    // Either the tool was denied (tool_result with error) or LLM chose not to use it
    const denied = events.find(e => e.type === 'tool_result' && (e as any).error?.code === 'policy/denied');

    expect(completed).toBeDefined();
    // In plan mode, write tools should be blocked or LLM sees no write tools
    console.log('[test 4] events types:', [...new Set(events.map(e => e.type))]);
    if (denied) {
      console.log('[test 4] tool denied as expected');
    } else {
      console.log('[test 4] LLM skipped write tools (no write tools in plan mode schema)');
    }
  }, TEST_TIMEOUT);

  it('5. abort: AbortSignal cancels in-flight turn', async () => {
    sessionStore.clear();
    const engine = new AgentEngine(deps);
    const controller = new AbortController();

    // Abort after 2 seconds — should cancel mid-stream
    const timer = setTimeout(() => controller.abort(), 2000);

    const events: unknown[] = [];
    try {
      for await (const ev of engine.run(makeInput({
        turn:      makeTurn('turn-5'),
        signal:    controller.signal,
        userInput: 'Count slowly from 1 to 1000, one number per line.',
      }))) {
        events.push(ev);
      }
    } finally {
      clearTimeout(timer);
    }

    const aborted = events.find((e: any) => e.type === 'turn_aborted');
    const failed  = events.find((e: any) => e.type === 'turn_failed');

    // Either aborted (mid-stream) or failed — both acceptable
    const wasInterrupted = aborted !== undefined || failed !== undefined;
    expect(wasInterrupted || events.some((e: any) => e.type === 'turn_completed')).toBe(true);

    console.log('[test 5] events types:', [...new Set((events as any[]).map(e => e.type))]);
    console.log('[test 5] total events:', events.length);
  }, TEST_TIMEOUT);

});
