import type { LlmTool, Message } from '@ema-agent/llm';
import type { ToolPool } from '@ema-agent/tools';
import type { ContextUsageEstimate } from './contextUsage.js';

/** 组装一次 Provider 中立请求所需的全部事实。 */
export interface AssembleContextInput {
  /** getSystemPrompt() 的原始有序结果，必须恰好包含一个动态边界哨兵。 */
  readonly systemPrompt: readonly string[];
  /** 与执行器共享的同一个根 Turn 冻结 ToolPool。 */
  readonly toolPool: ToolPool;
  /** 唯一允许 Compact 改写的消息区间，不得包含 system 消息。 */
  readonly history: readonly Message[];
  /**
   * 当前根 Turn 的工作消息：持久化 reminder 的回放、用户输入和已完成的本 Turn
   * 工具轮次。Context 不生成、不插入 reminder——它在 Turn 开始时已作为
   * kind='reminder' 的 Session Message 持久化，经有序 History 到达这里。
   */
  readonly currentTurn: readonly Message[];
  readonly contextWindow: number;
}

/** 一次 LLM Call 真正发送前的最终 Provider 中立输入。 */
export interface PreparedContext {
  readonly messages: readonly Message[];
  readonly tools: readonly LlmTool[];
  readonly usage: ContextUsageEstimate;
}
