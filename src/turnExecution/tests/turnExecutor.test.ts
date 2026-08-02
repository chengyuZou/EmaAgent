// 测试根 Turn 在输入准备失败时仍保持 started → failed 的完整生命周期。

import { describe, expect, it, vi } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
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
});
