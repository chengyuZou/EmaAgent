import type { GitSummary } from '@ema-agent/git';
import type { LlmToolDef, Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn';
import type { ToolPool } from '@ema-agent/tools';
import type { ContextUsageEstimate } from './contextUsage.js';

/** 当前 LLM Call 的运行时事实；字段顺序由 systemReminder 固定，调用方不能自由插队。 */
export interface ContextReminder {
  /** 调用方冻结的 ISO 日期或日期时间，Context 不读取系统时钟。 */
  readonly currentDate: string;
  /** Git 包本次读取的只读事实；Context 只在 Work 模式投影可用仓库摘要。 */
  readonly gitSummary?: GitSummary;
  /** Memory 本根 Turn 的召回正文，不写回 Session History。 */
  readonly memoryRecall?: string;
  /** Narrative always 策略本根 Turn 的召回正文。 */
  readonly narrativeRecall?: string;
  /** Task 包生成的低频任务提醒。 */
  readonly taskReminder?: string;
  /** 当前 Agent 的 Scratchpad 投影，每次 LLM Call 可以变化。 */
  readonly scratchpad?: string;
  /** 子 Agent 邮箱本次原子取出的消息。 */
  readonly mailboxMessages?: readonly string[];
}

/** 组装一次 Provider 中立请求所需的全部事实。 */
export interface AssembleContextInput {
  readonly executionProfile: ExecutionProfile;
  /** getSystemPrompt() 的原始有序结果，必须恰好包含一个动态边界哨兵。 */
  readonly systemPrompt: readonly string[];
  /** 与执行器共享的同一个根 Turn 冻结 ToolPool。 */
  readonly toolPool: ToolPool;
  /** 唯一允许 Compact 改写的消息区间，不得包含 system 消息。 */
  readonly history: readonly Message[];
  /** 当前根 Turn 的工作消息，包含用户输入和已完成的本 Turn 工具轮次。 */
  readonly currentTurn: readonly Message[];
  readonly reminder: ContextReminder;
  readonly contextWindow: number;
}

/** 一次 LLM Call 真正发送前的最终 Provider 中立输入。 */
export interface PreparedContext {
  readonly messages: readonly Message[];
  readonly tools: readonly LlmToolDef[];
  readonly usage: ContextUsageEstimate;
}
