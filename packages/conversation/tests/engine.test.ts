import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, MessageId, SessionId, TurnId } from '@ema-agent/contracts';
import type { Turn } from '@ema-agent/session';
import { HookBus } from '@ema-agent/hook';
import { ConversationEngine } from '../src/engine.js';
import type { ConversationDeps } from '../src/types.js';

const sessionId = 'session-hook-sse' as SessionId;
const turnId = 'turn-hook-sse' as TurnId;

describe('ConversationEngine Hook 诊断事件', () => {
  it('在 Turn 终态事件之前输出结构化 hook_warning', async () => {
    const hooks = new HookBus();
    let beforeIdentity: { iteration: number; llmCallId: string } | undefined;
    let afterIdentity: {
      iteration: number;
      llmCallId: string;
      cacheReadInputTokens?: number;
      promptPrefixHash: string | null;
    } | undefined;
    let persistedAssistantBlocks: unknown;
    let persistedAssistantMessageId: MessageId | undefined;
    let assistantMessagePayload: unknown;
    hooks.register('beforeLlm', (ctx) => {
      beforeIdentity = {
        iteration: ctx.payload.iteration,
        llmCallId: ctx.payload.llmCallId,
      };
      return { kind: 'continue' };
    });
    hooks.register('afterLlmComplete', (ctx) => {
      afterIdentity = {
        iteration: ctx.payload.iteration,
        llmCallId: ctx.payload.llmCallId,
        cacheReadInputTokens: ctx.payload.usage.cacheReadInputTokens,
        promptPrefixHash: ctx.payload.promptPrefixHash,
      };
      return { kind: 'continue' };
    });
    hooks.register('afterAssistantMessage', (ctx) => {
      assistantMessagePayload = ctx.payload;
      return { kind: 'continue' };
    });
    hooks.register('onTurnEnd', () => {
      throw new Error('telemetry unavailable');
    }, {
      name: 'test:telemetry',
      critical: false,
    });

    let messageSeq = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: (input: { role: string; blocks: unknown }) => {
        const id = `message-${++messageSeq}` as MessageId;
        if (input.role === 'assistant') {
          persistedAssistantBlocks = input.blocks;
          persistedAssistantMessageId = id;
        }
        return { id };
      },
      completeTurn: () => undefined,
      failTurn: () => undefined,
      abortTurn: () => undefined,
    };
    const llm = {
      firstProviderId: () => 'provider-1',
      defaultModelFor: () => 'model-1',
      warnUnsupportedParts: () => [],
      stream: async function* () {
        yield { type: 'text_delta', blockIndex: 0, delta: 'ok' };
        yield {
          type: 'usage',
          inputTokens: 3,
          outputTokens: 1,
          cacheReadInputTokens: 2,
          cacheHitRate: 2 / 3,
        };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const emotion = {
      beginTurn: () => undefined,
      processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
      flush: () => ({ cleaned: '', events: [] }),
    };
    const deps: ConversationDeps = {
      session: session as never,
      hooks,
      llm: llm as never,
      emotion: emotion as never,
      narrative: {} as never,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'chat',
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
    const engine = new ConversationEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: new AbortController().signal,
      sessionId,
      mode: 'chat',
      userInput: 'hello',
      providerId: 'provider-1',
      model: 'model-1',
    })) {
      events.push(event);
    }

    const warningIndex = events.findIndex((event) => event.type === 'hook_warning');
    const completedIndex = events.findIndex((event) => event.type === 'turn_completed');
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(warningIndex);
    expect(events[warningIndex]).toEqual(expect.objectContaining({
      type: 'hook_warning',
      sessionId,
      turnId,
      hookEvent: 'onTurnEnd',
      handlerName: 'test:telemetry',
      failureKind: 'handler_error',
      message: 'telemetry unavailable',
    }));
    expect(afterIdentity).toEqual({
      ...beforeIdentity,
      cacheReadInputTokens: 2,
      promptPrefixHash: null,
    });
    expect(beforeIdentity?.iteration).toBe(1);
    expect(beforeIdentity?.llmCallId).toBeTruthy();
    expect(assistantMessagePayload).toEqual({
      messageId: persistedAssistantMessageId,
      blocks: [{ type: 'text', text: 'ok' }],
    });
    const hookBlocks = (assistantMessagePayload as { blocks: unknown }).blocks;
    expect(hookBlocks).toEqual(persistedAssistantBlocks);
    expect(hookBlocks).not.toBe(persistedAssistantBlocks);
    expect(Object.isFrozen(hookBlocks)).toBe(true);
    expect(Object.isFrozen(persistedAssistantBlocks)).toBe(false);
  });

  it('失败状态落盘后触发 onTurnFailure，并在 turn_failed 前输出 Hook 诊断', async () => {
    const order: string[] = [];
    const hooks = new HookBus();
    let failurePayload: unknown;
    hooks.register('onTurnFailure', (ctx) => {
      order.push('onTurnFailure');
      failurePayload = ctx.payload;
      throw new Error('failure telemetry unavailable');
    }, {
      name: 'test:failure-telemetry',
      critical: false,
    });

    let messageSeq = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: () => ({ id: `message-${++messageSeq}` as MessageId }),
      completeTurn: () => undefined,
      failTurn: () => { order.push('failTurn'); },
      abortTurn: () => undefined,
    };
    const llm = {
      firstProviderId: () => 'provider-1',
      defaultModelFor: () => 'model-1',
      warnUnsupportedParts: () => [],
      stream: async function* () {
        throw new Error('provider unavailable');
      },
    };
    const deps: ConversationDeps = {
      session: session as never,
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      narrative: {} as never,
    };
    const turn: Turn = {
      id: turnId,
      sessionId,
      branchId: null,
      mode: 'chat',
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
    const engine = new ConversationEngine(deps);
    for await (const event of engine.run({
      turn,
      signal: new AbortController().signal,
      sessionId,
      mode: 'chat',
      userInput: 'hello',
      providerId: 'provider-1',
      model: 'model-1',
    })) {
      events.push(event);
      if (event.type === 'hook_warning') order.push('hook_warning');
      if (event.type === 'turn_failed') order.push('turn_failed');
    }

    expect(order).toEqual(['failTurn', 'onTurnFailure', 'hook_warning', 'turn_failed']);
    expect(failurePayload).toEqual(expect.objectContaining({
      phase: 'provider',
      code: 'provider/server_error',
      message: 'provider unavailable',
      durationMs: expect.any(Number),
    }));
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'turn_failed' }));
  });
});
