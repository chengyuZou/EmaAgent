// 这里测试 AgentEngine 保存消息、调用 Hook 和处理 Turn 成功或失败的行为。

import { describe, expect, it } from 'vitest';
import type { MessageId, SessionId, TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/turn';
import type { Message, Turn } from '@ema-agent/session';
import { HookBus } from '@ema-agent/hooks';
import { ToolRegistry } from '@ema-agent/tools';
import { LlmToolArgumentsParseError } from '@ema-agent/llm';
import { AgentEngine } from '../engine.js';
import type { AgentDeps } from '../types.js';

const modelCapabilities = {
  resolve: () => ({
    input: {
      text: 'supported' as const,
      image: 'supported' as const,
      audio: 'supported' as const,
      file: 'supported' as const,
    },
    tools: 'supported' as const,
    reasoning: 'supported' as const,
    temperature: 'supported' as const,
    source: 'manual' as const,
  }),
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

function turnLifecycle(overrides: Partial<AgentDeps['turnLifecycle']> = {}): AgentDeps['turnLifecycle'] {
  return {
    complete: () => undefined,
    fail: () => undefined,
    abort: () => undefined,
    ...overrides,
  };
}

describe('AgentEngine 生命周期', () => {
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
    const deps: AgentDeps = {
      session: session as never,
      turnLifecycle: turnLifecycle(),
      hooks,
      llm: llm as never,
      modelCapabilities,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'agent',
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

    const events: EmaStreamEvent[] = [];
    const engine = new AgentEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: new AbortController().signal,
      userInput: 'hello',
      prompt,
      providerId: 'provider-1',
      model: 'model-1',
      workspaceRoot: '',
    })) {
      events.push(event);
    }

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
    const deps: AgentDeps = {
      session: session as never,
      turnLifecycle: turnLifecycle({ fail: () => { order.push('failTurn'); } }),
      hooks,
      llm: llm as never,
      modelCapabilities,
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
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'agent',
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

    const events: EmaStreamEvent[] = [];
    const engine = new AgentEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: new AbortController().signal,
      userInput: 'hello',
      prompt,
      providerId: 'provider-1',
      model: 'model-1',
      workspaceRoot: '',
    })) {
      events.push(event);
      if (event.type === 'turn_failed') order.push('turn_failed');
    }

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
    const deps: AgentDeps = {
      session: session as never,
      turnLifecycle: turnLifecycle({ abort: () => { order.push('abortTurn'); } }),
      hooks,
      llm: llm as never,
      modelCapabilities,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: new ToolRegistry(),
      permission: {} as never,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'agent',
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

    const events: EmaStreamEvent[] = [];
    const engine = new AgentEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: controller.signal,
      userInput: 'hello',
      prompt,
      providerId: 'provider-1',
      model: 'model-1',
      workspaceRoot: '',
    })) {
      events.push(event);
      if (event.type === 'turn_aborted') order.push('turn_aborted');
    }

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
    const deps: AgentDeps = {
      session: session as never,
      turnLifecycle: turnLifecycle({ fail: ({ code }) => { failedCode = code; } }),
      hooks,
      llm: llm as never,
      modelCapabilities,
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
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'agent',
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

    const events: EmaStreamEvent[] = [];
    const engine = new AgentEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: new AbortController().signal,
      userInput: 'hello',
      prompt,
      providerId: 'provider-1',
      model: 'model-1',
      workspaceRoot: '',
    })) {
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
