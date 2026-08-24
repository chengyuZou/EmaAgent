// 测试中立强度档在 Anthropic/Gemini 两个 adapter 的预算映射与 clamp。
import { describe, expect, it } from 'vitest';
import { buildAnthropicThinking } from '../protocols/anthropic.js';
import { buildGeminiThinkingConfig } from '../protocols/gemini.js';

describe('buildAnthropicThinking', () => {
  it('effort 映射为预算；budgetTokens 显式值优先；clamp 到 max_tokens - 1', () => {
    expect(buildAnthropicThinking({ enabled: true, effort: 'low' }, 100_000))
      .toEqual({ type: 'enabled', budget_tokens: 2_000 });
    expect(buildAnthropicThinking({ enabled: true, effort: 'max' }, 100_000))
      .toEqual({ type: 'enabled', budget_tokens: 32_000 });
    // 显式 budgetTokens 覆盖 effort 映射。
    expect(buildAnthropicThinking({ enabled: true, budgetTokens: 12_000, effort: 'low' }, 100_000))
      .toEqual({ type: 'enabled', budget_tokens: 12_000 });
    expect(buildAnthropicThinking({ enabled: true, effort: 'max' }, 10_000))
      .toEqual({ type: 'enabled', budget_tokens: 9_999 });
  });

  it('未开启不给 thinking 参数；输出上限放不下协议下限时直接拒绝', () => {
    expect(buildAnthropicThinking(undefined, 100_000)).toBeUndefined();
    expect(buildAnthropicThinking({ enabled: false }, 100_000)).toBeUndefined();
    expect(buildAnthropicThinking({ enabled: 'auto' }, 100_000)).toBeUndefined();
    expect(() => buildAnthropicThinking({ enabled: true }, 1_024)).toThrow(TypeError);
  });
});

describe('buildGeminiThinkingConfig', () => {
  it('effort 映射为 thinkingBudget；显式关闭给 0；clamp 到输出上限 - 1', () => {
    expect(buildGeminiThinkingConfig({ enabled: true, effort: 'high' }, 100_000))
      .toEqual({ includeThoughts: true, thinkingBudget: 16_000 });
    expect(buildGeminiThinkingConfig({ enabled: false }, 100_000))
      .toEqual({ thinkingBudget: 0 });
    expect(buildGeminiThinkingConfig({ enabled: true, effort: 'max' }, 20_000))
      .toEqual({ includeThoughts: true, thinkingBudget: 19_999 });
    expect(buildGeminiThinkingConfig(undefined, 100_000)).toBeUndefined();
  });
});
