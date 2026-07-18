// 测试 AskUser 等待、回答和取消严格推进 AgentTask CAS 状态。

import { describe, expect, it, vi } from 'vitest';
import { awaitAgentAnswer } from '../src/ask-user-lifecycle.js';
import type { AskUserRegistryLike, IAgentTaskStore } from '../src/types.js';

describe('awaitAgentAnswer', () => {
  it('按 wait_user → Promise → user_answered 顺序推进', async () => {
    let resolve!: (answers: Record<string, string>) => void;
    const order: string[] = [];
    const registry = registryWith(new Promise((done) => { resolve = done; }));
    const taskStore = taskStoreWith({
      waitUser: () => { order.push('wait_user'); return { ok: true }; },
      userAnswered: () => { order.push('user_answered'); return { ok: true }; },
    });

    const resultPromise = awaitAgentAnswer({
      taskId: 'turn-1',
      promptId: 'prompt-1',
      questions: [],
      turnId: 'turn-1',
      signal: new AbortController().signal,
      registry,
      taskStore,
    });
    resolve({ q0: 'yes' });

    await expect(resultPromise).resolves.toEqual({ answers: { q0: 'yes' } });
    expect(order).toEqual(['wait_user', 'user_answered']);
  });

  it('Turn 取消会解除 Registry 等待，且不把 cancelled 任务恢复为 running', async () => {
    const controller = new AbortController();
    const registry = registryWith(new Promise(() => {}));
    const userAnswered = vi.fn(() => ({ ok: true }));
    const taskStore = taskStoreWith({ userAnswered });

    const resultPromise = awaitAgentAnswer({
      taskId: 'turn-1',
      promptId: 'prompt-1',
      questions: [],
      turnId: 'turn-1',
      signal: controller.signal,
      registry,
      taskStore,
    });
    controller.abort(new Error('user stop'));

    await expect(resultPromise).rejects.toThrow('user stop');
    expect(registry.cancel).toHaveBeenCalledWith('prompt-1');
    expect(userAnswered).not.toHaveBeenCalled();
  });

  it('迟到回答未通过 promptId CAS 时拒绝继续运行工具', async () => {
    const registry = registryWith(Promise.resolve({ q0: 'late' }));
    const taskStore = taskStoreWith({
      userAnswered: () => ({ ok: false }),
    });

    await expect(awaitAgentAnswer({
      taskId: 'turn-1',
      promptId: 'old-prompt',
      questions: [],
      turnId: 'turn-1',
      signal: new AbortController().signal,
      registry,
      taskStore,
    })).rejects.toMatchObject({
      code: 'agent_task/prompt_transition_conflict',
      action: 'user_answered',
    });
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

function taskStoreWith(overrides: Partial<IAgentTaskStore>): IAgentTaskStore {
  return {
    claim: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    cancel: vi.fn(),
    waitUser: vi.fn(() => ({ ok: true })),
    userAnswered: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
}
