import { describe, expect, it } from 'vitest';
import type { EmaStreamEvent, MessageId, SessionId, TurnId } from '@ema-agent/contracts';
import type { Message, Turn } from '@ema-agent/session';
import { HookBus } from '@ema-agent/hook';
import { AgentEngine } from '../src/engine.js';
import type { AgentDeps } from '../src/types.js';

const sessionId = 'session-agent-failure' as SessionId;
const turnId = 'turn-agent-failure' as TurnId;

describe('AgentEngine Turn 失败生命周期', () => {
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
      hooks,
      llm: llm as never,
      emotion: {
        beginTurn: () => undefined,
        processChunk: (delta: string) => ({ cleaned: delta, events: [] }),
        flush: () => ({ cleaned: '', events: [] }),
      } as never,
      tools: {
        list: () => [],
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
});
