// 按结构化来源对一次模型调用做上下文用量分类估算,禁止对最终字符串猜关键词。
import {
  estimateLlmInputTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from '@ema-agent/token';
import type { Message } from '@ema-agent/llm';
import type { PromptSnapshot } from '@ema-agent/prompts';
import type { ToolManifestSnapshot } from '@ema-agent/tools';
import type { ContextContribution } from './types.js';

export interface ContextUsageCategories {
  readonly systemPrompt: number;
  readonly toolInstructions: number;
  readonly toolSchemas: number;
  readonly workspaceInstructions: number;
  readonly skills: number;
  readonly memory: number;
  readonly narrative: number;
  readonly messages: number;
  readonly attachments: number;
  readonly other: number;
}

/**
 * 分类合计恒等于 totalTokens(由构造保证);
 * accuracy 恒为估算诊断,Provider 返回的 usage 才是真实总量。
 */
export interface ContextUsageEstimate {
  readonly contextWindow: number;
  readonly totalTokens: number;
  readonly accuracy: 'heuristic';
  readonly categories: ContextUsageCategories;
}

export interface ContextUsageInput {
  readonly prompt: PromptSnapshot;
  readonly toolManifest?: ToolManifestSnapshot;
  /** 压缩后的最终循环历史(snapshot.history),不是压缩前原历史。 */
  readonly history: readonly Message[];
  /** 当前 Turn 消息,不参与压缩;媒体 token 归入 attachments 而非 messages。 */
  readonly currentTurn: readonly Message[];
  readonly contributions?: readonly ContextContribution[];
  readonly restoreContributions?: readonly ContextContribution[];
  readonly contextWindow: number;
}

export function computeContextUsage(input: ContextUsageInput): ContextUsageEstimate {
  let systemPrompt = 0;
  let toolInstructions = 0;
  let workspaceInstructions = 0;
  let skills = 0;
  for (const slot of input.prompt.slots) {
    const tokens = estimateTextTokens(slot.content);
    if (slot.id === 'workspace.instructions') workspaceInstructions += tokens;
    else if (
      slot.id === 'extension.skillCatalog'
      || slot.id.startsWith('skills.required.')
      || slot.id.startsWith('skills.active.')
    ) skills += tokens;
    else systemPrompt += tokens;
  }

  let toolSchemas = 0;
  if (input.toolManifest) {
    const definitions = input.toolManifest.entries.map((entry) => ({
      name: entry.name,
      description: entry.description,
      parameters: entry.inputJsonSchema,
    }));
    toolInstructions = estimateLlmInputTokens([], {
      tools: definitions.map((definition) => ({
        ...definition,
        parameters: {},
      })),
    }).totalTokens;
    const completeToolDefinitions = estimateLlmInputTokens([], {
      tools: definitions,
    }).totalTokens;
    toolSchemas = Math.max(0, completeToolDefinitions - toolInstructions);
  }

  let memory = 0;
  let narrative = 0;
  let other = 0;
  for (const contribution of [
    ...(input.contributions ?? []),
    ...(input.restoreContributions ?? []),
  ]) {
    const tokens = estimateMessagesTokens([contribution.message as Message]);
    if (contribution.source === 'memory') memory += tokens;
    else if (contribution.source === 'narrative') narrative += tokens;
    else if (contribution.source === 'skills') skills += tokens;
    else other += tokens;
  }

  let messages = estimateLlmInputTokens(input.history).totalTokens;
  let attachments = 0;
  const current = estimateLlmInputTokens(input.currentTurn);
  attachments += current.breakdown.imageTokens
    + current.breakdown.audioTokens
    + current.breakdown.documentTokens;
  messages += current.totalTokens - attachments;

  const categories: ContextUsageCategories = {
    systemPrompt,
    toolInstructions,
    toolSchemas,
    workspaceInstructions,
    skills,
    memory,
    narrative,
    messages,
    attachments,
    other,
  };
  return {
    contextWindow: input.contextWindow,
    totalTokens: Object.values(categories).reduce((sum, value) => sum + value, 0),
    accuracy: 'heuristic',
    categories,
  };
}
