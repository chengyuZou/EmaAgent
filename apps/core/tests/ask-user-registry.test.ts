// 测试 Ask User 只能由所属 Turn 回答或取消，避免串行请求关联错位。
import { describe, expect, it } from 'vitest';
import { AskUserRegistry } from '../src/ask-user/registry.js';
import { asSessionId, asTurnId } from '@ema-agent/contracts';

describe('AskUserRegistry Turn 归属', () => {
  it('拒绝其他 Turn 响应，并通过显式取消解除等待', async () => {
    const registry = new AskUserRegistry(60_000);
    const pending = registry.createWithId('prompt-1', undefined, 'turn-1', {
      type: 'ask_confirm_required',
      sessionId: asSessionId('session-1'),
      turnId: asTurnId('turn-1'),
      promptId: 'prompt-1',
      question: '是否继续？',
    });

    expect(registry.listPending()).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ promptId: 'prompt-1', question: '是否继续？' }),
      }),
    ]);

    expect(registry.respond('prompt-1', { answer: 'wrong' }, 'turn-2')).toBe(false);
    expect(registry.cancel('prompt-1', 'turn-2')).toBe(false);
    expect(registry.size()).toBe(1);

    expect(registry.cancel('prompt-1', 'turn-1')).toBe(true);
    await expect(pending.promise).resolves.toEqual({});
    expect(registry.size()).toBe(0);
    expect(registry.listPending()).toEqual([]);
  });
});
