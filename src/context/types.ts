import type { LLMTool, Message } from '@ema-agent/llm';
import type { PromptBlock } from '@ema-agent/prompts';
import type { ToolPool } from '@ema-agent/tools';
import type { ContextUsageEstimate } from './contextUsage.js';

export interface AssembleContextInput {
  /** 静态与动态 Prompt 块, 按数组顺序发送并保留块自身的缓存标记. */
  readonly systemPrompt: readonly PromptBlock[];
  /** 与本次执行器共用的 ToolPool, 保持模型可见工具与可执行工具一致. */
  readonly toolPool: ToolPool;
  /** 全部有效工作消息, 不包含 system 消息. */
  readonly messages: readonly Message[];
  readonly contextWindow: number;
}

export interface PreparedContext {
  readonly messages: readonly Message[];
  readonly tools: readonly LLMTool[];
  readonly usage: ContextUsageEstimate;
}
