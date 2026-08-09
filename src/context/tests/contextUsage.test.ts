// 验证 Provider Usage 只替换总输入，不重复叠加缓存子集或伪造分类精度。
import { describe, expect, it } from 'vitest';
import {
  estimatedContextUsage,
  providerContextUsage,
  type ContextUsageEstimate,
} from '../contextUsage.js';

const estimate: ContextUsageEstimate = {
  contextWindow: 200_000,
  estimatedInputTokens: 12_000,
  accuracy: 'heuristic',
  categories: [{ kind: 'messages', tokens: 12_000 }],
};

describe('Context Usage 投影', () => {
  it('估算阶段使用 Context 的最终候选总量', () => {
    expect(estimatedContextUsage(estimate)).toEqual({
      contextWindow: 200_000,
      inputTokens: 12_000,
      source: 'estimate',
      categories: estimate.categories,
    });
  });

  it('Provider 阶段直接使用 inputTokens，缓存字段只是子集', () => {
    expect(providerContextUsage(estimate, {
      inputTokens: 10_000,
      outputTokens: 500,
      cacheReadInputTokens: 8_000,
      cacheWriteInputTokens: 1_000,
    })).toEqual({
      contextWindow: 200_000,
      inputTokens: 10_000,
      source: 'provider',
      categories: estimate.categories,
      cacheReadInputTokens: 8_000,
      cacheWriteInputTokens: 1_000,
    });
  });
});
