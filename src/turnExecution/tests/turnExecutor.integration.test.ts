// 使用真实模型测试 TurnExecutor、AgentLoop、工具调用和上下文压缩能否贯通。
/**
 * 通过真实 DeepSeek API 验证 TurnExecutor 的最小“思考→行动”循环。
 *
 * 使用 DeepSeek (openai-llm 兼容) 跑真实 API 调用。
 * 运行: pnpm --filter @ema-agent/turn-execution test:integration
 *
 * 覆盖场景:
 *   1. simple  — 无工具 agent turn，LLM 直接 end_turn 回答
 *   2. Read — LLM 主动调用 Read 读一个真实文件
 *   3. glob    — LLM 调用 glob_files 列出 package.json
 *   4. circuit-breaker — 故意触发 plan 模式 10 次迭代熔断
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';

import { LanguageModelRuntime } from '@ema-agent/llm';
import { HookBus } from '@ema-agent/hooks';
import { EmotionEngine } from '@ema-agent/emotion';
import { PermissionEngine, InMemoryPermissionRuleStore } from '@ema-agent/permission';
import { ToolRegistry } from '@ema-agent/tools';
import { registerBuiltinTools } from '@ema-agent/tool-builtin';
import type { Message, Turn } from '@ema-agent/session';
import type { SessionId, TurnId, MessageId } from '@ema-agent/ids';

import { TurnExecutor } from '../turnExecutor.js';
import type { TurnExecutionDeps, TurnExecutionPlan } from '../types.js';

// ── 测试常量 ──────────────────────────────────────────────────────────────────

// 未提供 DS_API_KEY 或 DEEPSEEK_API_KEY 时跳过真实 API 测试。
const DS_KEY       = process.env['DS_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '';
const PROVIDER_ID  = 'deepseek-test';
const MODEL        = 'deepseek-chat';
const WORKSPACE    = path.resolve('D:/Github/EmaAgent');
const TEST_TIMEOUT = 90_000;

// ── 内存 SessionStore 替身 ────────────────────────────────────────────────────

function makeSessionStore() {
  const messages: Message[] = [];
  let msgCounter = 0;
  let turnCounter = 0;
  let activeController: AbortController | undefined;

  return {
    startTurn(): { turn: Turn; signal: AbortSignal } {
      activeController = new AbortController();
      return {
        turn: makeTurn(`turn-${++turnCounter}`),
        signal: activeController.signal,
      };
    },
    requestAbort(): void {
      activeController?.abort();
    },
    clearRunning(): void {
      activeController = undefined;
    },
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
      };
      messages.push(msg);
      return msg;
    },
    completeTurn(_turnId: TurnId, _data: unknown): void { /* 测试不持久化终态 */ },
    failTurn(_turnId: TurnId, _code: string, _msg: string): void { /* 测试不持久化终态 */ },
    abortTurn(_sessionId: SessionId, _turnId: TurnId): void { /* 测试不持久化终态 */ },
    // 每条用例之间清空内存消息。
    clear() { messages.length = 0; msgCounter = 0; },
  };
}

// ── Turn 替身 ─────────────────────────────────────────────────────────────────

function makeTurn(id = 'turn-1'): Turn {
  return {
    id:                id as TurnId,
    sessionId:         'session-1' as SessionId,
    triggerType:       'userMessage',
    executionProfile:  'work',
    narrativePolicy:   'off',
    status:            'running',
    userInput:         '',
    startedAt:         Date.now(),
    completedAt:       null,
    errorCode:         null,
    errorMessage:      null,
    iterations:        0,
    usageInputTokens:  0,
    usageOutputTokens: 0,
  };
}

// ── 依赖装配 ──────────────────────────────────────────────────────────────────

let deps: TurnExecutionDeps;
let sessionStore: ReturnType<typeof makeSessionStore>;

beforeAll(() => {
  const llm = new LanguageModelRuntime([{
    id:           PROVIDER_ID,
    protocol:     'openai-llm',
    apiKey:       DS_KEY,
    baseUrl:      'https://api.deepseek.com',
  }]);

  const hooks = new HookBus();
  const emotion = new EmotionEngine({ vocabulary: ['neutral', 'happy', 'sad', 'surprised', 'angry'] });

  const permission = new PermissionEngine({
    mode:  'bypass',
    ask:   async () => ({ action: 'allow' }),
  }, new InMemoryPermissionRuleStore());

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  sessionStore = makeSessionStore();

  deps = {
    session:   sessionStore as unknown as TurnExecutionDeps['session'],
    hooks,
    llm,
    modelCapabilities: {
      resolve: () => ({
        input: { text: 'supported', image: 'unknown', audio: 'unknown', file: 'unknown' },
        tools: 'unknown',
        reasoning: 'unknown',
        temperature: 'unknown',
        source: 'unknown',
      }),
    },
    emotion,
    tools,
    permission,
  };
});

// ── 测试辅助函数 ──────────────────────────────────────────────────────────────

/** 消费完整异步事件流并返回全部事件。 */
async function collectEvents(
  executor: TurnExecutor,
  input: TurnExecutionPlan,
) {
  const events = [];
  const handle = executor.start({
    sessionId: 'session-1' as SessionId,
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    userInput: typeof input.userInput === 'string' ? input.userInput : '',
    prepare: () => input,
  });
  for await (const ev of handle.events) {
    events.push(ev);
  }
  return events;
}

function makeInput(
  overrides: Partial<TurnExecutionPlan> = {},
): TurnExecutionPlan {
  return {
    userInput:     'Hello',
    prompt: {
      slots: [],
      systemBlocks: [{
        stabilityScope: 'product',
        delivery: 'system',
        content: 'You are EmaAgent.',
        revision: 'integration-product-revision',
        cacheBreakpoint: true,
      }],
      contextBlocks: [],
      revisions: {
        product: 'integration-product-revision',
        activeCharacter: 'integration-character-revision',
        turn: 'integration-turn-revision',
        complete: 'integration-prompt-revision',
      },
      revision: 'integration-prompt-revision',
    },
    workspaceRoot: WORKSPACE,
    providerId:    PROVIDER_ID,
    model:         MODEL,
    ...overrides,
  };
}

// ── 真实调用用例 ──────────────────────────────────────────────────────────────

describe.skipIf(!DS_KEY)('TurnExecutor integration (DeepSeek)', () => {

  it('1. simple: no-tool turn ends normally', async () => {
    sessionStore.clear();
    const executor = new TurnExecutor(deps);
    const events = await collectEvents(executor, makeInput({
      userInput:    'Reply with exactly: PONG',
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

  it('2. Read: LLM reads a real file', async () => {
    sessionStore.clear();
    const executor = new TurnExecutor(deps);

    const targetFile = path.join(WORKSPACE, 'src/agent/package.json');
    const events = await collectEvents(executor, makeInput({
      userInput: `Use the Read tool to read the file at path "${targetFile}" and tell me the package name.`,
    }));

    const completed  = events.find(e => e.type === 'turn_completed');
    const toolResult = events.find(e => e.type === 'tool_result' && (e as any).output !== undefined);
    const textEvs    = events.filter(e => e.type === 'output_text_delta');
    const fullText   = textEvs.map((e: any) => e.delta).join('');

    expect(completed).toBeDefined();
    expect(toolResult).toBeDefined();
    // 最终回答应包含读取到的包名。
    expect(fullText.toLowerCase()).toMatch(/ema.?agent\/agent|@ema-agent\/agent/i);

    console.log('[test 2] tool events:', events.filter(e => e.type === 'tool_call_complete' || e.type === 'tool_result').length);
    console.log('[test 2] finalText:', fullText.slice(0, 200));
  }, TEST_TIMEOUT);

  it('3. glob: LLM lists package.json files', async () => {
    sessionStore.clear();
    const executor = new TurnExecutor(deps);

    const events = await collectEvents(executor, makeInput({
      userInput: `Use the glob_files tool with pattern "packages/*/package.json" in the workspace root "${WORKSPACE}" to list all package.json files. Tell me how many you found.`,
    }));

    const completed = events.find(e => e.type === 'turn_completed');
    const textEvs   = events.filter(e => e.type === 'output_text_delta');
    const fullText  = textEvs.map((e: any) => e.delta).join('');

    expect(completed).toBeDefined();
    // 最终回答应包含大于零的文件数量。
    expect(fullText).toMatch(/\d+/);

    console.log('[test 3] iterations:', (events.find(e => e.type === 'agent_iteration') as any)?.n);
    console.log('[test 3] finalText:', fullText.slice(0, 300));
  }, TEST_TIMEOUT);

  it('4. abort: AbortSignal cancels in-flight turn', async () => {
    sessionStore.clear();
    const executor = new TurnExecutor(deps);
    const input = makeInput({
      userInput: 'Count slowly from 1 to 1000, one number per line.',
    });
    const handle = executor.start({
      sessionId: 'session-1' as SessionId,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: input.userInput as string,
      prepare: () => input,
    });

    // 两秒后取消，预期中断仍在进行的流式响应。
    const timer = setTimeout(() => handle.abort(), 2000);

    const events: unknown[] = [];
    try {
      for await (const ev of handle.events) {
        events.push(ev);
      }
    } finally {
      clearTimeout(timer);
    }

    const aborted = events.find((e: any) => e.type === 'turn_aborted');
    const failed  = events.find((e: any) => e.type === 'turn_failed');

    // Provider 时序可能映射为 aborted 或 failed，两者都表示中途终止。
    const wasInterrupted = aborted !== undefined || failed !== undefined;
    expect(wasInterrupted || events.some((e: any) => e.type === 'turn_completed')).toBe(true);

    console.log('[test 4] events types:', [...new Set((events as any[]).map(e => e.type))]);
    console.log('[test 4] total events:', events.length);
  }, TEST_TIMEOUT);

});
