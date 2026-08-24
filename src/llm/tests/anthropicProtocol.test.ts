// 测试中立缓存断点只在 Anthropic 协议投影为 cache_control，以及 thinking 同模型重放。
import { describe, expect, it } from 'vitest';
import { toAnthropicMessages } from '../protocols/anthropic.js';

describe('toAnthropicMessages', () => {
  it('保留多层 system 与消息尾缓存断点', () => {
    const converted = toAnthropicMessages([
      { role: 'system', content: 'product', cacheBreakpoint: true },
      { role: 'system', content: 'character', cacheBreakpoint: true },
      { role: 'user', content: 'history' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], cacheBreakpoint: true },
    ], 'claude-sonnet');

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

  it('同模型生成的历史 thinking 随 signature 原样重放', () => {
    const converted = toAnthropicMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '内部思考', signature: 'sig-1' },
          { type: 'text', text: 'answer' },
        ],
        generatedBy: { providerId: 'anthropic', modelId: 'claude-sonnet', protocol: 'anthropic-llm' },
      },
    ], 'claude-sonnet');

    expect(converted.messages).toEqual([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '内部思考', signature: 'sig-1' },
        { type: 'text', text: 'answer' },
      ],
    }]);
  });

  it('跨模型或无来源的历史 thinking 被删除，text 保留', () => {
    const converted = toAnthropicMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '旧模型思考', signature: 'sig-old' },
          { type: 'text', text: 'answer' },
        ],
        generatedBy: { providerId: 'anthropic', modelId: 'claude-haiku', protocol: 'anthropic-llm' },
      },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '无来源思考', signature: 'sig-none' }],
      },
    ], 'claude-sonnet');

    expect(converted.messages[0]!.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(converted.messages[1]!.content).toEqual([]);
  });
});
