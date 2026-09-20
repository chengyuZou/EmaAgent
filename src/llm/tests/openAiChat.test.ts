// 验证 OpenAI Chat 流在 Provider 已输出正文但迟迟不结束时仍能立即响应 Turn 取消。
import { describe, expect, it, vi } from 'vitest';
import { createOpenAiChatProtocol } from '../protocols/openAiChat.js';

const openAiMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openAiMocks.create } },
  })),
}));

describe('OpenAI Chat protocol cancellation', () => {
  it('流输出正文后卡在下一帧时，AbortSignal 会终止消费', async () => {
    let readCount = 0;
    openAiMocks.create.mockResolvedValue({
      [Symbol.asyncIterator]() {
        return {
          next() {
            readCount += 1;
            if (readCount === 1) {
              return Promise.resolve({
                done: false,
                value: { choices: [{ delta: { content: '已输出正文' }, finish_reason: null }] },
              });
            }
            return new Promise(() => undefined);
          },
        };
      },
    });
    const controller = new AbortController();
    const call = createOpenAiChatProtocol({ providerId: 'test', apiKey: 'key' }, 'model');
    const stream = call({
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'text_delta', delta: '已输出正文' },
    });
    const pending = stream.next();
    controller.abort();

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('abort_timeout')), 50)),
    ])).rejects.toMatchObject({ name: 'AbortError' });
  });
});
