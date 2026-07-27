// 测试根 Turn 的 AskUser 等待、回答和取消。

import { describe, expect, it, vi } from 'vitest';
import {
  awaitUserAnswer,
  type AskUserInteractionPort,
} from '../awaitUserAnswer.js';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { AskUserInteractionOutcome } from '@ema-agent/turn';

const request: AskUserRequiredEvent = {
  type: 'ask_user_required',
  sessionId: 'session-1',
  turnId: 'turn-1',
  promptId: 'prompt-1',
  questions: [],
};

describe('awaitUserAnswer', () => {
  it('Registry 回答会恢复根 Turn', async () => {
    let resolve!: (outcome: AskUserInteractionOutcome) => void;
    const interaction = interactionWith(new Promise((done) => { resolve = done; }));

    const resultPromise = awaitUserAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: new AbortController().signal,
      interaction,
    });
    resolve({ status: 'answered', answers: { q0: 'yes' } });

    await expect(resultPromise).resolves.toEqual({ answers: { q0: 'yes' } });
    expect(interaction.createWithId).toHaveBeenCalledWith(
      'prompt-1',
      undefined,
      'turn-1',
      request,
    );
  });

  it('Turn 取消会解除 Registry 等待', async () => {
    const controller = new AbortController();
    const interaction = interactionWith(new Promise(() => {}));

    const resultPromise = awaitUserAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: controller.signal,
      interaction,
    });
    controller.abort(new Error('user stop'));

    await expect(resultPromise).rejects.toThrow('user stop');
    expect(interaction.cancel).toHaveBeenCalledWith('prompt-1');
  });

  it.each([
    { status: 'cancelled' as const, reason: 'user cancelled' },
    { status: 'timed_out' as const, reason: 'timed out after 1000ms' },
  ])('AskUser $status 不会伪装成正常空答案', async (outcome) => {
    const interaction = interactionWith(Promise.resolve(outcome));

    await expect(awaitUserAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: new AbortController().signal,
      interaction,
    })).rejects.toThrow(outcome.reason);
  });
});

function interactionWith(promise: Promise<AskUserInteractionOutcome>): AskUserInteractionPort {
  return {
    createWithId: vi.fn(() => ({ promise })),
    cancel: vi.fn(() => true),
  };
}
