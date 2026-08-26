// 验证 Provider Usage 只替换总输入，不重复叠加缓存子集或伪造分类精度。
import { describe, expect, it } from 'vitest';
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
  categories: {
    systemPromptTokens: 1_000,
    tools: {
      totalTokens: 2_000,
      systemToolTokens: 800,
      mcpToolTokens: 1_200,
    },
    skillTokens: 1_000,
    memoryTokens: 1_000,
    characterPromptTokens: 1_000,
    messageTokens: 6_000,
  },
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

  it('按六个一级业务来源分类，MCP 指引计入 MCP Tools', () => {
    const result = estimateContextUsage({
      contextWindow: 200_000,
      promptSections: [
        { name: 'product-rules', message: { role: 'system', content: '系统规则' } },
        { name: 'skill-catalog', message: { role: 'system', content: '技能目录' } },
        { name: 'memory-guidance', message: { role: 'system', content: '记忆指引' } },
        { name: 'character', message: { role: 'system', content: '角色设定' } },
        { name: 'mcp-instructions', message: { role: 'system', content: 'MCP 指引' } },
      ],
      tools: [
        {
          origin: { kind: 'builtin' },
          definition: { name: 'Read', description: '读取', inputSchema: {} },
        },
        {
          origin: { kind: 'mcp', serverName: 'files', serverToolName: 'read' },
          definition: { name: 'McpRead', description: 'MCP 读取', inputSchema: {} },
        },
      ],
      history: [{ role: 'user', content: '旧消息' }],
      currentTurn: [{ role: 'user', content: '本轮 reminder 与输入' }],
    });

    const categories = result.categories;
    expect(categories.systemPromptTokens).toBeGreaterThan(0);
    expect(categories.skillTokens).toBeGreaterThan(0);
    expect(categories.memoryTokens).toBeGreaterThan(0);
    expect(categories.characterPromptTokens).toBeGreaterThan(0);
    expect(categories.messageTokens).toBeGreaterThan(0);
    expect(categories.tools.systemToolTokens).toBeGreaterThan(0);
    expect(categories.tools.mcpToolTokens).toBeGreaterThan(categories.tools.systemToolTokens);
    expect(categories.tools.totalTokens).toBe(
      categories.tools.systemToolTokens + categories.tools.mcpToolTokens,
    );
    expect(result.estimatedInputTokens).toBe(
      categories.systemPromptTokens
      + categories.tools.totalTokens
      + categories.skillTokens
      + categories.memoryTokens
      + categories.characterPromptTokens
      + categories.messageTokens,
    );
  });

  it('Provider 校正后新增的模型历史只增加 Messages', () => {
    const corrected = providerContextUsage(estimate, {
      inputTokens: 10_000,
      outputTokens: 500,
    });
    const next = appendEstimatedContextMessages(corrected, [
      { role: 'assistant', content: '新增回答' },
    ]);

    expect(next.source).toBe('estimate');
    expect(next.inputTokens).toBeGreaterThan(10_000);
    expect(next.categories.messageTokens).toBeGreaterThan(
      corrected.categories.messageTokens,
    );
    expect(next.categories.tools).toEqual(corrected.categories.tools);
  });
});
