import type { LlmTool, Message } from '@ema-agent/llm';
import type { PromptBlock } from '@ema-agent/prompts';
import type { ToolPool } from '@ema-agent/tools';
import type { ContextUsageEstimate } from './contextUsage.js';

/**
 * @param systemPrompt getSystemPrompt() 的原始有序块；数组顺序即发送顺序，断点只来自块自身标记
 * @param toolPool 与执行器共享的同一个根 Turn 冻结 ToolPool
 * @param messages 当前的全部有效工作消息, 不包含 system 消息.
*/
export interface AssembleContextInput {
  readonly systemPrompt: readonly PromptBlock[];
  readonly toolPool: ToolPool;
  readonly messages: readonly Message[];
  readonly contextWindow: number;
}

/** 一次 LLM Call 真正发送前的最终 Provider 中立输出 */
export interface PreparedContext {
  readonly messages: readonly Message[];
  readonly tools: readonly LlmTool[];
  readonly usage: ContextUsageEstimate;
}
