import { describe, expect, it } from 'vitest';
import type { LlmMessage, LlmToolDef } from '../types.js';
import {
  computePromptPrefixHash,
  normalizeToolDefinitions,
} from '../prompt-cache.js';
import { toAnthropicMessages } from '../adapters/anthropic.js';
import { createLlmTokenUsage } from '../usage.js';

const stableSystem: LlmMessage = {
  role: 'system',
  content: 'You are Ema.',
  cacheBreakpoint: true,
};

describe('Prompt KV Cache 稳定前缀', () => {
  it('动态后缀变化不改变前缀 Hash，稳定内容变化会改变', () => {
    const first = computePromptPrefixHash({
      messages: [stableSystem, { role: 'user', content: 'first question' }],
    });
    const second = computePromptPrefixHash({
      messages: [stableSystem, { role: 'user', content: 'different question' }],
    });
    const changedSystem = computePromptPrefixHash({
      messages: [
        { ...stableSystem, content: 'You are another character.' },
        { role: 'user', content: 'first question' },
      ],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changedSystem).not.toBe(first);
  });

  it('工具注册顺序和 Schema key 构造顺序不会破坏前缀', () => {
    const alpha: LlmToolDef = {
      name: 'alpha',
      description: 'alpha tool',
      parameters: {
        required: ['path'],
        properties: { path: { description: 'file', type: 'string' } },
        type: 'object',
      },
    };
    const alphaDifferentKeyOrder: LlmToolDef = {
      name: 'alpha',
      description: 'alpha tool',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'file' } },
        required: ['path'],
      },
    };
    const beta: LlmToolDef = {
      name: 'beta',
      description: 'beta tool',
      parameters: { type: 'object', properties: {} },
    };

    const first = computePromptPrefixHash({
      messages: [stableSystem],
      tools: [beta, alpha],
    });
    const second = computePromptPrefixHash({
      messages: [stableSystem],
      tools: [alphaDifferentKeyOrder, beta],
    });

    expect(first).toBe(second);
    expect(normalizeToolDefinitions([beta, alpha]).map((tool) => tool.name))
      .toEqual(['alpha', 'beta']);
  });

  it('没有显式 cacheBreakpoint 时不伪造前缀 Hash', () => {
    expect(computePromptPrefixHash({
      messages: [{ role: 'system', content: 'not cacheable yet' }],
    })).toBeNull();
  });

  it('Anthropic 把 system 断点映射为 cache_control block', () => {
    const normalized = toAnthropicMessages([
      stableSystem,
      { role: 'user', content: 'hello' },
    ]);

    expect(normalized.system).toEqual([
      {
        type: 'text',
        text: 'You are Ema.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(normalized.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('只用 Provider 返回的缓存计数计算命中率', () => {
    expect(createLlmTokenUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 10,
      cacheEligibleInputTokens: 100,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 10,
      cacheHitRate: 0.8,
    });

    expect(createLlmTokenUsage({ inputTokens: 10, outputTokens: 5 }))
      .toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});
