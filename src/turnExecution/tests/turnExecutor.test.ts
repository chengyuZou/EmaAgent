// 测试根 Turn 在输入准备失败时仍保持 started → failed 的完整生命周期。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import { SessionInteractionQueue } from '@ema-agent/turn';
import type { Turn } from '@ema-agent/session';
import { TurnExecutor } from '../turnExecutor.js';

describe('TurnExecutor 生命周期', () => {
  it('创建 Turn 后立即发 started，准备失败再发 failed', async () => {
    const turn: Turn = {
      id: asTurnId('turn-1'),
      sessionId: asSessionId('session-1'),
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'auto',
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
    const failTurn = vi.fn();
    const clearRunning = vi.fn();
    const executor = new TurnExecutor({
      session: {
        startTurn: () => ({
          turn,
          signal: new AbortController().signal,
        }),
        getTurn: () => turn,
        getActiveTurn: () => turn,
        requestAbort: () => undefined,
        failTurn,
        clearRunning,
      } as never,
      interactions: { cancelForTurn: () => 0 },
    }, {} as never);

    const handle = executor.start({
      sessionId: turn.sessionId,
      triggerType: turn.triggerType,
      executionProfile: turn.executionProfile,
      narrativePolicy: turn.narrativePolicy,
      userInput: turn.userInput,
      prepare: async () => {
        throw new Error('prompt unavailable');
      },
    });
    const events = [];
    for await (const event of handle.events) events.push(event);

    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      code: 'turn/setup_failed',
    });
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'turn_failed',
    ]);
    expect(failTurn).toHaveBeenCalledWith(
      turn.id,
      'turn/setup_failed',
      'prompt unavailable',
    );
    expect(clearRunning).toHaveBeenCalledWith(turn.sessionId, turn.id);
  });

  it('根 Turn 中止会结束同 Turn 的 Permission 与 AskUser 等待', async () => {
    const turn: Turn = {
      id: asTurnId('turn-interaction-abort'),
      sessionId: asSessionId('session-interaction-abort'),
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'auto',
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
    const abortController = new AbortController();
    const interactions = new SessionInteractionQueue<
      { toolId: string },
      { action: 'deny'; reason?: string },
      { question: string }
    >(null, reason => ({ action: 'deny', reason }));
    const permission = interactions.enqueuePermission({
      sessionId: turn.sessionId,
      turnId: turn.id,
      toolCallId: 'tool-call-abort',
      prompt: { toolId: 'bash' },
    });
    const askUser = interactions.enqueueAskUser({
      promptId: 'ask-user-abort',
      sessionId: turn.sessionId,
      turnId: turn.id,
      request: { question: '继续吗？' },
    });
    const executor = new TurnExecutor({
      session: {
        startTurn: () => ({ turn, signal: abortController.signal }),
        getTurn: () => turn,
        getActiveTurn: () => turn,
        requestAbort: () => abortController.abort(new Error('user stop')),
        abortTurn: vi.fn(),
        clearRunning: vi.fn(),
      } as never,
      interactions,
    }, {} as never);

    const handle = executor.start({
      sessionId: turn.sessionId,
      triggerType: turn.triggerType,
      executionProfile: turn.executionProfile,
      narrativePolicy: turn.narrativePolicy,
      userInput: turn.userInput,
      prepare: ({ signal }) => {
        if (signal.aborted) throw signal.reason;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const events = [];
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'turn_started') handle.abort();
    }

    await expect(handle.completion).resolves.toMatchObject({ status: 'aborted' });
    expect(events.map(event => event.type)).toEqual(['turn_started', 'turn_aborted']);
    await expect(permission.promise).resolves.toEqual({
      action: 'deny',
      reason: 'turn aborted',
    });
    await expect(askUser.promise).resolves.toEqual({
      status: 'cancelled',
      reason: 'turn aborted',
    });
    expect(interactions.size()).toBe(0);
  });
});
