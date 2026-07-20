// 测试稳定 Prompt 前缀只受缓存边界之前的消息和规范化 Tool Manifest 影响。
import { describe, expect, it } from 'vitest';
import type { LlmToolDef, Message } from '@ema-agent/llm';
import {
  computePromptPrefixHash,
  normalizeToolDefinitions,
} from '../promptPrefix.js';

const stableSystem: Message = {
  role: 'system',
  content: 'You are Ema.',
  cacheBreakpoint: true,
};

describe('Prompt 前缀稳定性', () => {
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

  it('Tool 注册顺序和 Schema key 构造顺序被整理成同一 Manifest', () => {
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

    const firstTools = normalizeToolDefinitions([beta, alpha]);
    const secondTools = normalizeToolDefinitions([alphaDifferentKeyOrder, beta]);
    const first = computePromptPrefixHash({ messages: [stableSystem], tools: firstTools });
    const second = computePromptPrefixHash({ messages: [stableSystem], tools: secondTools });

    expect(first).toBe(second);
    expect(firstTools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
  });

  it('没有显式 cacheBreakpoint 时不伪造前缀 Hash', () => {
    expect(computePromptPrefixHash({
      messages: [{ role: 'system', content: 'not cacheable yet' }],
    })).toBeNull();
  });
});
