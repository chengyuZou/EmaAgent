// 测试 TurnExecutor 保存消息、调用 Hook 和处理 Turn 成功或失败的行为。

import { describe, expect, it } from 'vitest';
import type { MessageId, SessionId, TurnId } from '@ema-agent/ids';
import type { TurnExecutionEvent as EmaStreamEvent } from '../types.js';
import type { Message, Turn } from '@ema-agent/session';
import { HookBus } from '@ema-agent/hooks';
import { ToolRegistry } from '@ema-agent/tools';
import { LlmToolArgumentsParseError } from '@ema-agent/llm';
import { TurnExecutor } from '../turnExecutor.js';
import { TurnPreparationError } from '../errors.js';
import type { TurnExecutionDeps } from '../types.js';

const model = {
  providerId: 'provider-1',
  model: 'model-1',
  capabilities: {
    input: {
      text: 'supported' as const,
      image: 'supported' as const,
      audio: 'supported' as const,
      file: 'supported' as const,
    },
    tools: 'supported' as const,
    reasoning: 'supported' as const,
    temperature: 'supported' as const,
    contextWindow: 200_000,
    source: 'manual' as const,
  },
};

const sessionId = 'session-agent-failure' as SessionId;
const turnId = 'turn-agent-failure' as TurnId;
const prompt = {
  slots: [],
  systemBlocks: [{
    stabilityScope: 'product',
    delivery: 'system',
    content: 'test system prompt',
    revision: 'test-product-revision',
    cacheBreakpoint: true,
  }],
  contextBlocks: [],
  revisions: {
    product: 'test-product-revision',
    activeCharacter: 'test-character-revision',
    turn: 'test-turn-revision',
    complete: 'test-prompt-revision',
  },
  revision: 'test-prompt-revision',
} as const;

function makeTurn(): Turn {
  return {
    id: turnId,
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    status: 'running',
    userInput: 'hello',
    startedAt: Date.now(),
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    iterations: 0,
    usageInputTokens: 0,
    usageOutputTokens: 0,
  };
}

function withTurnStart<T extends object>(
  session: T,
  controller = new AbortController(),
): T & {
  startTurn: () => { turn: Turn; signal: AbortSignal };
  requestAbort: () => void;
  clearRunning: () => void;
} {
  return {
    ...session,
    startTurn: () => ({ turn: makeTurn(), signal: controller.signal }),
    requestAbort: () => controller.abort(),
    clearRunning: () => undefined,
  };
}

function startExecution(executor: TurnExecutor) {
  return executor.start({
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'work',
    narrativePolicy: 'off',
    userInput: 'hello',
    prepare: () => ({
      userInput: 'hello',
      persistedUserInput: 'hello',
      prompt,
      model,
      workspaceRoot: '',
      requestDegradations: [],
    }),
  });
}

describe('TurnExecutor 生命周期', () => {
  it('start 同步创建一次 Turn，准备失败仍产生唯一终态并释放运行锁', async () => {
    let startCount = 0;
    let clearCount = 0;
    const failed: Array<{ code: string; message?: string }> = [];
    const session = {
      startTurn: () => {
        startCount++;
        return {
          turn: makeTurn(),
          signal: new AbortController().signal,
        };
      },
      requestAbort: () => undefined,
      clearRunning: () => { clearCount++; },
      failTurn: (_id: TurnId, code: string, message?: string) => {
        failed.push({ code, message });
      },
      abortTurn: () => undefined,
    };
    const executor = new TurnExecutor({
      session: session as never,
      hooks: new HookBus(),
      llm: {} as never,
      emotion: {} as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    });

    const handle = executor.start({
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'hello',
      prepare: () => {
        throw new TurnPreparationError('turn/attachment_failed', 'attachment unavailable');
      },
    });

    expect(startCount).toBe(1);
    expect(handle.sessionId).toBe(sessionId);
    expect(handle.turnId).toBe(turnId);

    const iterator = handle.events[Symbol.asyncIterator]();
    expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
      'TurnHandle.events only supports one consumer',
    );
    const events: EmaStreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    await expect(handle.completion).resolves.toEqual({
      status: 'failed',
      sessionId,
      turnId,
      code: 'turn/attachment_failed',
      message: 'attachment unavailable',
    });
    expect(events.at(-1)).toEqual({
      type: 'turn_failed',
      sessionId,
      turnId,
      code: 'turn/attachment_failed',
      message: 'attachment unavailable',
    });
    expect(failed).toEqual([{
      code: 'turn/attachment_failed',
      message: 'attachment unavailable',
    }]);
    expect(clearCount).toBe(1);
  });

  it('输入准备阶段取消时触发 onTurnAbort 并提交 aborted 终态', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const hooks = new HookBus();
    hooks.register('onTurnAbort', () => {
      order.push('onTurnAbort');
      return { kind: 'continue' };
    });
    const session = {
      startTurn: () => ({
        turn: makeTurn(),
        signal: controller.signal,
      }),
      requestAbort: () => controller.abort(),
      clearRunning: () => { order.push('clearRunning'); },
      failTurn: () => { order.push('failTurn'); },
      abortTurn: () => { order.push('abortTurn'); },
    };
    const executor = new TurnExecutor({
      session: session as never,
      hooks,
      llm: {} as never,
      emotion: {} as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    });

    const handle = executor.start({
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'off',
      userInput: 'hello',
      prepare: () => {
        controller.abort();
        throw controller.signal.reason;
      },
    });
    const events: EmaStreamEvent[] = [];
    for await (const event of handle.events) events.push(event);

    await expect(handle.completion).resolves.toEqual({
      status: 'aborted',
      sessionId,
      turnId,
      reason: 'user_stop',
    });
    expect(order).toEqual(['onTurnAbort', 'abortTurn', 'clearRunning']);
    expect(events).toEqual([{
      type: 'turn_aborted',
      sessionId,
      turnId,
      reason: 'user_stop',
    }]);
  });

  it('assistant 消息落盘后发送相同的结构化 blocks', async () => {
    const hooks = new HookBus();
    let persistedAssistantBlocks: unknown;
    let persistedAssistantMessageId: MessageId | undefined;
    let assistantMessagePayload: unknown;
    let llmCompletePayload: unknown;
    hooks.register('afterLlmComplete', (ctx) => {
      llmCompletePayload = ctx.payload;
      return { kind: 'continue' };
    });
    hooks.register('afterAssistantMessage', (ctx) => {
      assistantMessagePayload = ctx.payload;
      return { kind: 'continue' };
    });

    let messageSequence = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: (input: {
        turnId: TurnId;
        sessionId: SessionId;
        role: Message['role'];
        blocks: Message['blocks'];
      }): Message => {
        const id = `message-${++messageSequence}` as MessageId;
        if (input.role === 'assistant') {
          persistedAssistantBlocks = input.blocks;
          persistedAssistantMessageId = id;
        }
        return {
          id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          role: input.role,
          kind: 'normal',
          blocks: input.blocks,
          interrupted: false,
          createdAt: Date.now(),
        };
      },
      failTurn: () => undefined,
      completeTurn: () => undefined,
      abortTurn: () => undefined,
    };
    const llm = {
      stream: async function* () {
        yield { type: 'thinking_delta', blockIndex: 0, delta: 'reason' };
        yield { type: 'text_delta', blockIndex: 1, delta: 'answer' };
        yield {
          type: 'usage',
          inputTokens: 3,
          outputTokens: 2,
          cacheReadInputTokens: 2,
          cacheHitRate: 2 / 3,
        };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const deps: TurnExecutionDeps = {
      session: withTurnStart(session) as never,
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    };
    const events: EmaStreamEvent[] = [];
    const executor = new TurnExecutor(deps);
    const handle = startExecution(executor);
    for await (const event of handle.events) {
      events.push(event);
    }
    await expect(handle.completion).resolves.toEqual(
      expect.objectContaining({ status: 'completed', sessionId, turnId }),
    );

    expect(assistantMessagePayload).toEqual({
      messageId: persistedAssistantMessageId,
      blocks: [
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'answer' },
      ],
    });
    const hookBlocks = (assistantMessagePayload as { blocks: unknown }).blocks;
    expect(hookBlocks).toEqual(persistedAssistantBlocks);
    expect(hookBlocks).not.toBe(persistedAssistantBlocks);
    expect(Object.isFrozen(hookBlocks)).toBe(true);
    expect(Object.isFrozen(persistedAssistantBlocks)).toBe(false);
    expect(llmCompletePayload).toEqual(expect.objectContaining({
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cacheReadInputTokens: 2,
        cacheHitRate: 2 / 3,
      },
      promptPrefixHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(events).toContainEqual({
      type: 'usage_update',
      sessionId,
      turnId,
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'turn_completed' }));
  });

  it('先持久化失败，再触发 onTurnFailure，最后发送 turn_failed', async () => {
    const order: string[] = [];
    const hooks = new HookBus();
    let failurePayload: unknown;
    hooks.register('onTurnFailure', (ctx) => {
      order.push('onTurnFailure');
      failurePayload = ctx.payload;
      return { kind: 'continue' };
    });

    let messageSequence = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: (input: {
        turnId: TurnId;
        sessionId: SessionId;
        role: Message['role'];
        blocks: Message['blocks'];
      }): Message => ({
        id: `message-${++messageSequence}` as MessageId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: input.role,
        kind: 'normal',
        blocks: input.blocks,
        interrupted: false,
        createdAt: Date.now(),
      }),
      failTurn: () => { order.push('failTurn'); },
      completeTurn: () => undefined,
      abortTurn: () => undefined,
    };
    const llm = {
      stream: async function* () {
        throw new Error('provider unavailable');
      },
    };
    const deps: TurnExecutionDeps = {
      session: withTurnStart(session) as never,
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: {
        list: () => [],
        manifestSnapshot: () => ({
          registryVersion: 0,
          revision: 'test-empty-manifest',
          entries: [],
        }),
      } as never,
      permission: {} as never,
    };
    const events: EmaStreamEvent[] = [];
    const executor = new TurnExecutor(deps);
    const handle = startExecution(executor);
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_failed') order.push('turn_failed');
    }
    await expect(handle.completion).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        code: 'provider/server_error',
        sessionId,
        turnId,
      }),
    );

    expect(order).toEqual(['failTurn', 'onTurnFailure', 'turn_failed']);
    expect(failurePayload).toEqual(expect.objectContaining({
      phase: 'provider',
      code: 'provider/server_error',
      message: 'provider unavailable',
      durationMs: expect.any(Number),
    }));
    expect(events.filter((event) => event.type === 'turn_failed')).toHaveLength(1);
  });

  it('LLM 取消只落为 turn_aborted，不执行正常完成或失败终态', async () => {
    const order: string[] = [];
    const hooks = new HookBus();
    hooks.register('onTurnAbort', () => {
      order.push('onTurnAbort');
      return { kind: 'continue' };
    });
    hooks.register('onTurnEnd', () => {
      order.push('onTurnEnd');
      return { kind: 'continue' };
    });

    const controller = new AbortController();
    let messageSequence = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: (input: {
        turnId: TurnId;
        sessionId: SessionId;
        role: Message['role'];
        blocks: Message['blocks'];
      }): Message => ({
        id: `message-${++messageSequence}` as MessageId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: input.role,
        kind: 'normal',
        blocks: input.blocks,
        interrupted: false,
        createdAt: Date.now(),
      }),
      completeTurn: () => { order.push('completeTurn'); },
      failTurn: () => { order.push('failTurn'); },
      abortTurn: () => { order.push('abortTurn'); },
    };
    const llm = {
      stream: async function* () {
        controller.abort();
        throw controller.signal.reason;
      },
    };
    const deps: TurnExecutionDeps = {
      session: withTurnStart(session, controller) as never,
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    };
    const events: EmaStreamEvent[] = [];
    const executor = new TurnExecutor(deps);
    const handle = startExecution(executor);
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_aborted') order.push('turn_aborted');
    }
    await expect(handle.completion).resolves.toEqual({
      status: 'aborted',
      sessionId,
      turnId,
      reason: 'user_stop',
    });

    expect(order).toEqual(['onTurnAbort', 'abortTurn', 'turn_aborted']);
    expect(events.at(-1)).toEqual({
      type: 'turn_aborted',
      sessionId,
      turnId,
      reason: 'user_stop',
    });
    expect(events.some((event) => event.type === 'turn_completed')).toBe(false);
    expect(events.some((event) => event.type === 'turn_failed')).toBe(false);
  });

  it('损坏的 Tool JSON 以专用 Provider 错误失败且不进入工具执行', async () => {
    const hooks = new HookBus();
    let failedCode: string | undefined;
    let toolLookupCount = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: (input: {
        turnId: TurnId;
        sessionId: SessionId;
        role: Message['role'];
        blocks: Message['blocks'];
      }): Message => ({
        id: 'message-tool-json' as MessageId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: input.role,
        kind: 'normal',
        blocks: input.blocks,
        interrupted: false,
        createdAt: Date.now(),
      }),
      completeTurn: () => undefined,
      failTurn: (_id: TurnId, code: string) => { failedCode = code; },
      abortTurn: () => undefined,
    };
    const llm = {
      stream: async function* () {
        throw new LlmToolArgumentsParseError(
          'provider-1',
          'call-invalid',
          'delete_file',
          '{"path":',
        );
      },
    };
    const deps: TurnExecutionDeps = {
      session: withTurnStart(session) as never,
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: {
        list: () => [],
        manifestSnapshot: () => ({
          registryVersion: 0,
          revision: 'test-empty-manifest',
          entries: [],
        }),
        get: () => {
          toolLookupCount++;
          throw new Error('不应查询或执行工具');
        },
      } as never,
      permission: {} as never,
    };
    const events: EmaStreamEvent[] = [];
    const executor = new TurnExecutor(deps);
    const handle = startExecution(executor);
    for await (const event of handle.events) {
      events.push(event);
    }

    expect(failedCode).toBe('provider/tool_arguments_invalid_json');
    expect(toolLookupCount).toBe(0);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'turn_failed',
      code: 'provider/tool_arguments_invalid_json',
    }));
  });
});
