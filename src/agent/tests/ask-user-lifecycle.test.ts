// 测试根 Turn 的 AskUser 等待、回答和取消。

import { describe, expect, it, vi } from 'vitest';
import { awaitAgentAnswer } from '../ask-user-lifecycle.js';
import type { AskUserRequiredEvent } from '@ema-agent/tools';
import type { AskUserInteractionOutcome } from '@ema-agent/turn';
import type { AskUserRegistryLike } from '../types.js';

const request: AskUserRequiredEvent = {
  type: 'ask_user_required',
  sessionId: 'session-1',
  turnId: 'turn-1',
  promptId: 'prompt-1',
  questions: [],
};

describe('awaitAgentAnswer', () => {
  it('Registry 回答会恢复根 Turn', async () => {
    let resolve!: (outcome: AskUserInteractionOutcome) => void;
    const registry = registryWith(new Promise((done) => { resolve = done; }));

    const resultPromise = awaitAgentAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: new AbortController().signal,
      registry,
    });
    resolve({ status: 'answered', answers: { q0: 'yes' } });

    await expect(resultPromise).resolves.toEqual({ answers: { q0: 'yes' } });
    expect(registry.createWithId).toHaveBeenCalledWith(
      'prompt-1',
      undefined,
      'turn-1',
      request,
    );
  });

  it('Turn 取消会解除 Registry 等待', async () => {
    const controller = new AbortController();
    const registry = registryWith(new Promise(() => {}));

    const resultPromise = awaitAgentAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: controller.signal,
      registry,
    });
    controller.abort(new Error('user stop'));

    await expect(resultPromise).rejects.toThrow('user stop');
    expect(registry.cancel).toHaveBeenCalledWith('prompt-1');
  });

  it.each([
    { status: 'cancelled' as const, reason: 'user cancelled' },
    { status: 'timed_out' as const, reason: 'timed out after 1000ms' },
  ])('AskUser $status 不会伪装成正常空答案', async (outcome) => {
    const registry = registryWith(Promise.resolve(outcome));

    await expect(awaitAgentAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: new AbortController().signal,
      registry,
    })).rejects.toThrow(outcome.reason);
  });
});

function registryWith(promise: Promise<AskUserInteractionOutcome>): AskUserRegistryLike {
  return {
    createWithId: vi.fn(() => ({ promise })),
    cancel: vi.fn(() => true),
  };
}
