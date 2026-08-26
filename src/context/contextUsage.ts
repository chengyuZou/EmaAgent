// 估算根请求的业务来源占用，并用 Provider 输入真值校正同一次调用的总量。
import type { LlmTokenUsage, LlmTool, Message } from '@ema-agent/llm';
import {
  estimateLlmInputTokens,
  type TokenEstimateAccuracy,
} from '@ema-agent/token';
import type { ToolOrigin } from '@ema-agent/tools';

export interface ContextUsageCategories {
  readonly systemPromptTokens: number;
  readonly tools: {
    readonly totalTokens: number;
    readonly systemToolTokens: number;
    readonly mcpToolTokens: number;
  };
  readonly skillTokens: number;
  readonly memoryTokens: number;
  readonly characterPromptTokens: number;
  readonly messageTokens: number;
}

export interface ContextUsageEstimate {
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
  readonly accuracy: TokenEstimateAccuracy;
  readonly categories: ContextUsageCategories;
}

export interface ContextUsage {
  readonly contextWindow: number;
  readonly inputTokens: number;
  readonly source: 'estimate' | 'provider';
  /** Provider 没有业务分类，分类始终来自与该调用配对的本地装配。 */
  readonly categories: ContextUsageCategories;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export interface ContextUsagePromptSection {
  readonly name: string;
  readonly message: Message;
}

export interface ContextUsageTool {
  readonly origin: ToolOrigin;
  readonly definition: LlmTool;
}

export interface EstimateContextUsageInput {
  readonly contextWindow: number;
  readonly promptSections: readonly ContextUsagePromptSection[];
  readonly tools: readonly ContextUsageTool[];
  readonly history: readonly Message[];
  readonly currentTurn: readonly Message[];
}

export function estimateContextUsage(
  input: EstimateContextUsageInput,
): ContextUsageEstimate {
  const skillPrompt = input.promptSections.filter(
    section => section.name === 'skill-catalog',
  );
  const memoryPrompt = input.promptSections.filter(
    section => section.name === 'memory-guidance',
  );
  const characterPrompt = input.promptSections.filter(
    section => section.name === 'character',
  );
  const mcpPrompt = input.promptSections.filter(
    section => section.name === 'mcp-instructions',
  );
  const systemPrompt = input.promptSections.filter(section => (
    section.name !== 'skill-catalog'
    && section.name !== 'memory-guidance'
    && section.name !== 'character'
    && section.name !== 'mcp-instructions'
  ));

  const systemToolDefinitions = input.tools
    .filter(tool => tool.origin.kind === 'builtin')
    .map(tool => tool.definition);
  const mcpToolDefinitions = input.tools
    .filter(tool => tool.origin.kind === 'mcp')
    .map(tool => tool.definition);

  const systemToolTokens = estimateTools(systemToolDefinitions);
  const mcpToolTokens = estimateTools(mcpToolDefinitions)
    + estimateMessages(mcpPrompt.map(section => section.message));
  const categories: ContextUsageCategories = {
    systemPromptTokens: estimateMessages(systemPrompt.map(section => section.message)),
    tools: {
      totalTokens: systemToolTokens + mcpToolTokens,
      systemToolTokens,
      mcpToolTokens,
    },
    skillTokens: estimateMessages(skillPrompt.map(section => section.message)),
    memoryTokens: estimateMessages(memoryPrompt.map(section => section.message)),
    characterPromptTokens: estimateMessages(
      characterPrompt.map(section => section.message),
    ),
    // Reminder 已经是 Session 历史；与其他模型可见消息统一计算，不走旁路分类。
    messageTokens: estimateMessages([...input.history, ...input.currentTurn]),
  };

  return {
    contextWindow: input.contextWindow,
    estimatedInputTokens: totalCategoryTokens(categories),
    accuracy: 'heuristic',
    categories,
  };
}

export function estimatedContextUsage(estimate: ContextUsageEstimate): ContextUsage {
  return {
    contextWindow: estimate.contextWindow,
    inputTokens: estimate.estimatedInputTokens,
    source: 'estimate',
    categories: estimate.categories,
  };
}

export function providerContextUsage(
  estimate: ContextUsageEstimate,
  usage: LlmTokenUsage,
): ContextUsage {
  return {
    contextWindow: estimate.contextWindow,
    inputTokens: usage.inputTokens,
    source: 'provider',
    categories: estimate.categories,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
  };
}

/** Provider 锚点之后又进入工作历史的消息，统一归 Messages。 */
export function appendEstimatedContextMessages(
  current: ContextUsage,
  messages: readonly Message[],
): ContextUsage {
  const addedTokens = estimateMessages(messages);
  if (addedTokens === 0) return current;
  return {
    ...current,
    inputTokens: current.inputTokens + addedTokens,
    source: 'estimate',
    categories: {
      ...current.categories,
      messageTokens: current.categories.messageTokens + addedTokens,
    },
  };
}

function estimateMessages(messages: readonly Message[]): number {
  return estimateLlmInputTokens(messages).totalTokens;
}

function estimateTools(tools: readonly LlmTool[]): number {
  if (tools.length === 0) return 0;
  return estimateLlmInputTokens([], {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    })),
  }).totalTokens;
}

function totalCategoryTokens(categories: ContextUsageCategories): number {
  return categories.systemPromptTokens
    + categories.tools.totalTokens
    + categories.skillTokens
    + categories.memoryTokens
    + categories.characterPromptTokens
    + categories.messageTokens;
}
