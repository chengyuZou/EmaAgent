// 验证 Context 圆环只使用总输入: 本地估算、Provider 实报和后续消息追加.
import { describe, expect, it } from 'vitest';
import { estimateLlmInputTokens } from '@ema-agent/token';
import {
  appendEstimatedContextMessages,
  estimateContextUsage,
  estimatedContextUsage,
  providerContextUsage,
  type ContextUsageEstimate,
} from '../contextUsage.js';

const estimate: ContextUsageEstimate = {
  contextWindow: 200_000,
  estimatedInputTokens: 12_000,
  accuracy: 'heuristic',
};

describe('Context Usage 投影', () => {
  it('估算阶段使用 Context 的最终候选总量', () => {
    expect(estimatedContextUsage(estimate)).toEqual({
      contextWindow: 200_000,
      inputTokens: 12_000,
      source: 'estimate',
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
      cacheReadInputTokens: 8_000,
      cacheWriteInputTokens: 1_000,
    });
  });

  it('Prompt、Tool、历史和当前 Turn 一起估算, 不再重复计算业务分类', () => {
    const promptMessages = [{ role: 'system' as const, content: '系统规则' }];
    const history = [{ role: 'user' as const, content: '旧消息' }];
    const currentTurn = [{ role: 'user' as const, content: '当前输入' }];
    const tools = [{ name: 'Read', description: '读取', inputSchema: {} }];
    const result = estimateContextUsage({
      contextWindow: 200_000,
      promptMessages,
      tools,
      history,
      currentTurn,
    });
    expect(result.estimatedInputTokens).toBe(estimateLlmInputTokens(
      [...promptMessages, ...history, ...currentTurn],
      { tools: [{ name: 'Read', description: '读取', parameters: {} }] },
    ).totalTokens);
  });

  it('Provider 校正后新增的模型历史使圆环重新标为估算', () => {
    const corrected = providerContextUsage(estimate, {
      inputTokens: 10_000,
      outputTokens: 500,
    });
    const next = appendEstimatedContextMessages(corrected, [
      { role: 'assistant', content: '新增回答' },
    ]);
    expect(next.source).toBe('estimate');
    expect(next.inputTokens).toBeGreaterThan(10_000);
  });
});
