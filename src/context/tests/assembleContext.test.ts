// 验证 Context 的固定顺序、缓存切口和分类总量；压缩由 Compact 单独测试。
import { describe, expect, it } from 'vitest';
import { PROMPT_DYNAMIC_BOUNDARY } from '@ema-agent/prompts';
import { ToolPool } from '@ema-agent/tools';
import { assembleContext } from '../assembleContext.js';
import { ContextAssemblyError } from '../errors.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    systemPrompt: [
      '# 产品规则\n稳定内容',
      PROMPT_DYNAMIC_BOUNDARY,
      '# 当前角色\n动态内容',
    ],
    toolPool: new ToolPool([]),
    history: [{ role: 'user' as const, content: '历史消息' }],
    currentTurn: [
      { role: 'user' as const, content: '<system-reminder>本 Turn 开始时的状态</system-reminder>' },
      { role: 'user' as const, content: '当前输入' },
    ],
    contextWindow: 100_000,
    ...overrides,
  };
}

describe('assembleContext', () => {
  it('剥离 Prompt 哨兵，按 Prompt → 历史 → 当前 Turn 顺序组装', () => {
    const result = assembleContext(input());

    expect(result.messages.map((message) => message.content)).toEqual([
      '# 产品规则\n稳定内容',
      '# 当前角色\n动态内容',
      '历史消息',
      '<system-reminder>本 Turn 开始时的状态</system-reminder>',
      '当前输入',
    ]);
    expect(result.messages[0]).toMatchObject({ cacheBreakpoint: true });
    expect(result.messages.at(-1)).toMatchObject({ cacheBreakpoint: true });
    expect(JSON.stringify(result.messages)).not.toContain(PROMPT_DYNAMIC_BOUNDARY);
    expect(result.usage.categories.reduce((sum, category) => sum + category.tokens, 0))
      .toBe(result.usage.estimatedInputTokens);
  });

  it('清除历史遗留的请求级缓存断点', () => {
    const result = assembleContext(input({
      history: [{ role: 'user', content: '历史消息', cacheBreakpoint: true }],
    }));
    expect(result.messages[2]).not.toHaveProperty('cacheBreakpoint');
    expect(result.messages.filter((message) => message.cacheBreakpoint)).toHaveLength(2);
  });

  it('拒绝把 system message 混进历史', () => {
    try {
      assembleContext(input({
        history: [{ role: 'system', content: '不应持久化的旧系统消息' }],
      }));
      throw new Error('预期 ContextAssemblyError');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextAssemblyError);
      expect(error).toMatchObject({
        code: 'context/system-message-outside-prompt',
      });
    }
  });
});
