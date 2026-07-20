// 测试中性的消息缓存断点只在 Anthropic 协议边界转换为 cache_control。
import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { toAnthropicMessages } from '../adapters/anthropic.js';

describe('Anthropic cache_control', () => {
  it('把 system 消息断点映射为 ephemeral cache_control block', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are Ema.', cacheBreakpoint: true },
      { role: 'user', content: 'hello' },
    ];

    const normalized = toAnthropicMessages(messages);

    expect(normalized.system).toEqual([{
      type: 'text',
      text: 'You are Ema.',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(normalized.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
