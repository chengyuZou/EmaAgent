// 测试 Provider 累计 Usage 快照只产生新增差值，并保持已经确认的单调计数。
import { describe, expect, it } from 'vitest';
import { advanceLlmUsageSnapshot } from '../usage.js';

describe('LLM Usage 累计快照', () => {
  it('把同一输入量的后续快照转换为纯输出增量', () => {
    const first = advanceLlmUsageSnapshot(
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 100, outputTokens: 0 },
    );
    const second = advanceLlmUsageSnapshot(
      first.snapshot,
      { inputTokens: 100, outputTokens: 20 },
    );

    expect(first.delta).toEqual({ inputTokens: 100, outputTokens: 0 });
    expect(second.delta).toEqual({ inputTokens: 0, outputTokens: 20 });
    expect(second.snapshot).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('Provider 计数倒退时不产生负增量', () => {
    const result = advanceLlmUsageSnapshot(
      { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40 },
      { inputTokens: 90, outputTokens: 18, cacheReadInputTokens: 30 },
    );

    expect(result.snapshot).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
    });
    expect(result.delta).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});
