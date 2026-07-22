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

  it('保留多层 system block 及各自缓存边界', () => {
    const normalized = toAnthropicMessages([
      { role: 'system', content: 'product', cacheBreakpoint: true },
      { role: 'system', content: 'active character', cacheBreakpoint: true },
      { role: 'system', content: 'turn profile' },
      { role: 'user', content: 'hello' },
    ]);

    expect(normalized.system).toEqual([
      {
        type: 'text',
        text: 'product',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'active character',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'turn profile' },
    ]);
  });
});
