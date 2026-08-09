// 测试 Provider 累计 Usage 倒退时不会产生负增量或重复计费。
import { describe, expect, it } from 'vitest';
import { advanceLlmUsageSnapshot, createLlmTokenUsage } from '../usage.js';

describe('LLM usage', () => {
  it('归一缓存命中率并保持累计快照单调', () => {
    const first = createLlmTokenUsage({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 40,
    });
    const advanced = advanceLlmUsageSnapshot(first, {
      inputTokens: 90,
      outputTokens: 20,
      cacheReadInputTokens: 35,
    });

    expect(first.cacheHitRate).toBe(0.4);
    expect(advanced.snapshot).toEqual(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
    }));
    expect(advanced.delta).toEqual(expect.objectContaining({
      inputTokens: 0,
      outputTokens: 10,
      cacheReadInputTokens: 0,
    }));
  });
});
