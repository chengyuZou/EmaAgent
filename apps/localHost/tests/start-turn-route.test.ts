// 验证 Turn 创建路由不会把显式提交的失效 Session 身份静默替换成新会话。

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { StartTurnRouteDependencies } from '../src/routes/turns/startTurn.js';
import { registerStartTurnRoute } from '../src/routes/turns/startTurn.js';
import { TurnEventHub } from '../src/sse/event-hub.js';
import { TurnEventStore } from '../src/sse/event-store.js';

describe('start Turn route', () => {
  it('显式 sessionId 不存在时返回 404，且不创建替代 Session', async () => {
    const createSession = vi.fn();
    const start = vi.fn();
    const app = new Hono();
    const dependencies = {
      fileAccess: { prepareAttachment: vi.fn() },
      session: {
        createSession,
        sessionExists: vi.fn(() => false),
      },
      executor: { start, abort: vi.fn() },
      inputPreparer: { prepare: vi.fn() },
      speechOutput: { decorate: vi.fn() },
    } as unknown as StartTurnRouteDependencies;
    registerStartTurnRoute(
      app,
      dependencies,
      new TurnEventStore(),
      new TurnEventHub(),
    );

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'deleted-session',
        trigger: { type: 'userMessage' },
        executionProfile: 'chat',
        narrativePolicy: 'auto',
        userInput: 'hello',
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'session_not_found' });
    expect(createSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('输出装饰器失败时按 completion 补发根 Turn 终态', async () => {
    const sessionId = asSessionId('session-1');
    const turnId = asTurnId('turn-1');
    const abort = vi.fn(() => true);
    const store = new TurnEventStore();
    const app = new Hono();
    const dependencies = {
      fileAccess: { prepareAttachment: vi.fn() },
      session: {
        createSession: vi.fn(),
        sessionExists: vi.fn(() => true),
      },
      executor: {
        abort,
        start: vi.fn(() => ({
          sessionId,
          turnId,
          events: emptyEvents(),
          completion: Promise.resolve({
            status: 'completed' as const,
            sessionId,
            turnId,
            stats: { inputTokens: 1, outputTokens: 2, durationMs: 3 },
          }),
          abort: vi.fn(),
        })),
      },
      inputPreparer: { prepare: vi.fn() },
      speechOutput: { decorate: () => failedEvents() },
    } as unknown as StartTurnRouteDependencies;
    registerStartTurnRoute(app, dependencies, store, new TurnEventHub());

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        trigger: { type: 'userMessage' },
        executionProfile: 'chat',
        narrativePolicy: 'auto',
        userInput: 'hello',
      }),
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(store.isDone(turnId)).toBe(true));
    expect(abort).toHaveBeenCalledWith(turnId);
    expect(store.replay(turnId, 0).at(-1)?.event).toMatchObject({
      type: 'turn_completed',
      sessionId,
      turnId,
    });
  });
});

async function* emptyEvents(): AsyncGenerator<never> {}

async function* failedEvents(): AsyncGenerator<never> {
  throw new Error('decorator failed');
}
