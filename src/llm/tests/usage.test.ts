import { describe, expect, it } from 'vitest';
import { createLLMTokenUsage, updateLLMCallUsage } from '../usage.js';

describe('LLM usage', () => {
  it('保持累计快照单调并只返回新增量', () => {
    const first = createLLMTokenUsage({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 40,
    });
    const updated = updateLLMCallUsage(first, {
      inputTokens: 90,
      outputTokens: 20,
      cacheReadInputTokens: 35,
    });

    expect(updated.usage).toEqual(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
    }));
    expect(updated.delta).toEqual(expect.objectContaining({
      inputTokens: 0,
      outputTokens: 10,
      cacheReadInputTokens: 0,
    }));
  });
});
