// 测试根 Turn 的 AskUser 等待、回答和取消。

import { describe, expect, it, vi } from 'vitest';
import { awaitAgentAnswer } from '../src/ask-user-lifecycle.js';
import type { AskUserRequiredEvent } from '@ema-agent/turn';
import type { AskUserRegistryLike } from '../src/types.js';

const request: AskUserRequiredEvent = {
  type: 'ask_user_required',
  sessionId: 'session-1',
  turnId: 'turn-1',
  promptId: 'prompt-1',
  questions: [],
};

describe('awaitAgentAnswer', () => {
  it('Registry 回答会恢复根 Turn', async () => {
    let resolve!: (answers: Record<string, string>) => void;
    const registry = registryWith(new Promise((done) => { resolve = done; }));

    const resultPromise = awaitAgentAnswer({
      promptId: 'prompt-1',
      request,
      turnId: 'turn-1',
      signal: new AbortController().signal,
      registry,
    });
    resolve({ q0: 'yes' });

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
});

function registryWith(promise: Promise<Record<string, string>>): AskUserRegistryLike {
  return {
    create: vi.fn(() => ({ promptId: 'generated', promise })),
    createWithId: vi.fn(() => ({ promise })),
    respond: vi.fn(() => true),
    cancel: vi.fn(() => true),
  };
}
