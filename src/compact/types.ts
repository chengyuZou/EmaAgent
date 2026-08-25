import type { LlmThinking, LlmTokenUsage, LlmTool, Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/session';
import type { CompactSettings } from './settings.js';
import type { CompactEvent } from './events.js';

// 设置接口(CompactSettings)与默认快照(DEFAULT_COMPACT_SETTINGS)统一在 settings.ts。

export interface CompactRequest {
  readonly sessionId: string;
  readonly executionProfile: ExecutionProfile;
  /** 仅包含允许被改写的历史；System Prompt、当前 Turn 与临时召回不在这里。 */
  readonly history: readonly Message[];
  /**
   * 摘要请求复用的系统消息段（与主对话同字节、含缓存断点标记），调用方从本轮
   * Context 装配结果取出。摘要请求 = systemMessages + 结构化历史 + 尾部压缩指令，
   * 以此共享主对话的 KV 缓存前缀。
   */
  readonly systemMessages: readonly Message[];
  /** 摘要请求复用的 Tool 定义（根 Turn 冻结集合，同内容同顺序）；模型不得真正调用。 */
  readonly tools: readonly LlmTool[];
  /** 摘要请求复用的中立 thinking 配置；缺省表示主请求未开启 thinking。 */
  readonly thinking?: LlmThinking;
  /** Context 对完整候选请求的最新本地估算（调用方调用时刻的最佳值；不得小于 history 本身）。 */
  readonly estimatedInputTokens: number;
  /** Provider 已明确报告超限时跳过阈值判断，强制尝试安全压缩。 */
  readonly force?: boolean;
  /**
   * 是否先跑 Micro（大 ToolResult 占位替换）；缺省 true。手动 /compact 传 false：
   * Micro 的替换从不落库，命令路径只要纯粹的 Macro 摘要。
   */
  readonly micro?: boolean;
  readonly contextWindow: number;
  /** 当前模型的输出硬上限（ProviderModel 事实，null/缺省 = 未知）；摘要输出预算按它裁剪。 */
  readonly modelMaxOutput?: number | null;
  readonly signal?: AbortSignal;
  /** 过程事件出口（Session 域，无 Turn 身份）；投影为谁的事件由调用方决定。 */
  readonly emit?: (event: CompactEvent) => void;
  /**
   * Macro 摘要持久化闭包（根 Turn / `/compact` Command 提供，子 Agent 不提供）。
   * 保存成功后 Compact 才发 compact_completed；闭包抛错则发 compact_failed 并原样上抛。
   */
  readonly saveMacroSummary?: (
    summary: string,
    summarizedMessageCount: number,
  ) => void;
  /** 根 Turn 启动时冻结的设置；不提供时使用构造时默认值。 */
  readonly settings?: Readonly<CompactSettings>;
}

/**
 * Compact 的唯一返回值。所有分支都返回下一次装配应使用的 history；
 * Macro 分支携带完整的终态事实——事件是这些事实的观察投影（供 Turn 事件流
 * 与前端展示），业务调用方只读结果，不反向从事件反查。
 */
export type CompactResult =
  | {
      readonly kind: 'unchanged';
      readonly history: readonly Message[];
      /** 仅 Macro 尝试失败时携带（与 compact_failed 事件同一事实）；未尝试的 unchanged 没有它。 */
      readonly failureDetail?: string;
    }
  | {
      readonly kind: 'micro';
      readonly history: readonly Message[];
    }
  | {
      readonly kind: 'macro';
      readonly history: readonly Message[];
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly savedTokens: number;
      readonly durationMs: number;
      /** 摘要调用的最终 usage（收完的 completion 快照）；调用方据此记账。 */
      readonly usage: LlmTokenUsage;
      /**
       * 输入 LLM 历史中从头开始被改写覆盖的消息数（含窗口截断与候选收缩的
       * 丢弃偏移）。Compact 不返回 Session Message ID；调用方经
       * LlmHistoryMessage[summarizedMessageCount - 1] 映射 summarizedThroughMessageId。
       */
      readonly summarizedMessageCount: number;
      /**
       * 实际被淘汰（未进入摘要）的总消息条数与估算 token：
       * 窗口一刀切 + 摘要模型输入预算候选收缩（含 Provider 判超重试的追加收缩）。
       */
      readonly droppedMessageCount: number;
      readonly droppedTokens: number;
    };
