// 测试中立缓存断点只在 Anthropic 协议投影为 cache_control。
import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../protocols/anthropic.js';

describe('toAnthropicMessages', () => {
  it('保留多层 system 与消息尾缓存断点', () => {
    const converted = toAnthropicMessages([
      { role: 'system', content: 'product', cacheBreakpoint: true },
      { role: 'system', content: 'character', cacheBreakpoint: true },
      { role: 'user', content: 'history' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], cacheBreakpoint: true },
    ]);

    expect(converted.system).toEqual([
      { type: 'text', text: 'product', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'character', cache_control: { type: 'ephemeral' } },
    ]);
    expect(converted.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'answer',
        cache_control: { type: 'ephemeral' },
      }],
    });
  });
});
