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
    hooks.register('onTurnEnd', () => {
      throw new Error('telemetry unavailable');
    }, {
      name: 'test:telemetry',
      critical: false,
    });

    let messageSeq = 0;
    const session = {
      loadHistory: () => [],
      appendMessage: () => ({ id: `message-${++messageSeq}` as MessageId }),
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
        yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
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
  });
});
