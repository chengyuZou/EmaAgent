// 按结构化来源估算一次最终请求，并把 Provider Usage 覆盖为同一完整投影。
import type {
  AssistantBlock,
  LlmTokenUsage,
  LlmToolDef,
  Message,
  UserBlock,
} from '@ema-agent/llm';
import {
  estimateLlmInputTokens,
  estimateTextTokens,
  type TokenEstimateAccuracy,
} from '@ema-agent/token';
import type { RenderedSystemReminder } from './systemReminder.js';

export type ContextUsageCategoryKind =
  | 'promptSection'
  | 'toolInstructions'
  | 'toolSchemas'
  | 'runtimeContext'
  | 'memoryRecall'
  | 'narrativeRecall'
  | 'messages'
  | 'toolCalls'
  | 'toolResults'
  | 'attachments'
  | 'other';

export interface ContextUsageCategory {
  readonly kind: ContextUsageCategoryKind;
  /** Prompt section 使用标题作为展示名；kind 才是稳定业务身份。 */
  readonly name?: string;
  readonly tokens: number;
}

export interface ContextUsageEstimate {
  readonly contextWindow: number;
  readonly estimatedInputTokens: number;
  readonly accuracy: TokenEstimateAccuracy;
  readonly categories: readonly ContextUsageCategory[];
}

export interface ContextUsage {
  readonly contextWindow: number;
  readonly inputTokens: number;
  readonly source: 'estimate' | 'provider';
  /** Provider 不提供分类事实，因此这里始终保留 Context 的估算分类。 */
  readonly categories: readonly ContextUsageCategory[];
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

interface PromptUsageSection {
  readonly name: string;
  readonly message: Message;
}

interface ContextUsageInput {
  readonly contextWindow: number;
  readonly messages: readonly Message[];
  readonly tools: readonly LlmToolDef[];
  readonly promptSections: readonly PromptUsageSection[];
  readonly history: readonly Message[];
  readonly reminder: RenderedSystemReminder;
  readonly currentTurn: readonly Message[];
}

/** Context 装配过程的内部估算入口；分类总和严格等于完整请求估算。 */
export function estimateContextUsage(input: ContextUsageInput): ContextUsageEstimate {
  const categories: ContextUsageCategory[] = [];

  for (const section of input.promptSections) {
    categories.push({
      kind: 'promptSection',
      name: section.name,
      tokens: estimateLlmInputTokens([section.message]).totalTokens,
    });
  }

  if (input.tools.length > 0) {
    const instructionTokens = estimateLlmInputTokens([], {
      tools: input.tools.map((tool) => ({ ...tool, parameters: {} })),
    }).totalTokens;
    const completeToolTokens = estimateLlmInputTokens([], {
      tools: input.tools,
    }).totalTokens;
    pushCategory(categories, 'toolInstructions', instructionTokens);
    pushCategory(categories, 'toolSchemas', Math.max(0, completeToolTokens - instructionTokens));
  }

  const reminderTokens = estimateLlmInputTokens([input.reminder.message]);
  let reminderContentBudget = Math.max(
    0,
    reminderTokens.totalTokens - reminderTokens.breakdown.messageEnvelopeTokens,
  );
  for (const section of input.reminder.sections) {
    const tokens = Math.min(reminderContentBudget, estimateTextTokens(section.content));
    pushCategory(categories, section.kind, tokens);
    reminderContentBudget -= tokens;
  }

  const messageUsage = classifyMessages([...input.history, ...input.currentTurn]);
  pushCategory(categories, 'messages', messageUsage.messages);
  pushCategory(categories, 'toolCalls', messageUsage.toolCalls);
  pushCategory(categories, 'toolResults', messageUsage.toolResults);
  pushCategory(categories, 'attachments', messageUsage.attachments);

  const complete = estimateLlmInputTokens(input.messages, { tools: input.tools });
  const classified = categories.reduce((sum, category) => sum + category.tokens, 0);
  pushCategory(categories, 'other', Math.max(0, complete.totalTokens - classified));

  return {
    contextWindow: input.contextWindow,
    estimatedInputTokens: complete.totalTokens,
    accuracy: complete.accuracy,
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

interface MessageUsage {
  messages: number;
  toolCalls: number;
  toolResults: number;
  attachments: number;
}

function classifyMessages(messages: readonly Message[]): MessageUsage {
  const usage: MessageUsage = {
    messages: 0,
    toolCalls: 0,
    toolResults: 0,
    attachments: 0,
  };

  for (const message of messages) {
    const complete = estimateLlmInputTokens([message]);
    usage.messages += complete.breakdown.messageEnvelopeTokens;
    if (typeof message.content === 'string') {
      usage.messages += complete.totalTokens - complete.breakdown.messageEnvelopeTokens;
      continue;
    }
    // assembleContext 已拒绝 history/currentTurn 中的 system message；此处保留
    // 分支以让独立估算函数在类型层也不把 system 误当成数组消息。
    if (message.role === 'system') continue;

    for (const block of message.content) {
      const tokens = estimateBlockTokens(message.role, block);
      if (block.type === 'tool_use') usage.toolCalls += tokens;
      else if (block.type === 'tool_result') usage.toolResults += tokens;
      else if (isAttachment(block)) usage.attachments += tokens;
      else usage.messages += tokens;
    }
  }

  return usage;
}

function estimateBlockTokens(
  role: 'user' | 'assistant',
  block: UserBlock | AssistantBlock,
): number {
  const message: Message = role === 'user'
    ? { role, content: [block as UserBlock] }
    : { role, content: [block as AssistantBlock] };
  const estimate = estimateLlmInputTokens([message]);
  return Math.max(0, estimate.totalTokens - estimate.breakdown.messageEnvelopeTokens);
}

function isAttachment(block: UserBlock | AssistantBlock): boolean {
  return block.type === 'image_url'
    || block.type === 'image_data'
    || block.type === 'audio_data'
    || block.type === 'file_data'
    || block.type === 'file_url';
}

function pushCategory(
  categories: ContextUsageCategory[],
  kind: ContextUsageCategoryKind,
  tokens: number,
): void {
  if (tokens <= 0) return;
  const existing = categories.find((category) => category.kind === kind && category.name === undefined);
  if (existing) {
    const index = categories.indexOf(existing);
    categories[index] = { ...existing, tokens: existing.tokens + tokens };
    return;
  }
  categories.push({ kind, tokens });
}
