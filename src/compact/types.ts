import type { LlmThinking, LlmTokenUsage, LlmTool, Message } from '@ema-agent/llm';
import type { SessionMode } from '@ema-agent/session';
import type { CompactSettings } from './settings.js';
import type { CompactEvent } from './events.js';

export interface CompactRequest {
  /** 手动 Compact 在占用 Session 前生成此 ID, 让取消、事件与用量记录使用同一身份. */
  readonly compactId?: string;
  readonly sessionId: string;
  readonly sessionMode: SessionMode;
  /** 按模型可见顺序排列的工作消息. System Prompt 不在此数组中. */
  readonly messages: readonly Message[];
  /**
   * 摘要请求复用的系统消息段(与主对话同字节, 含缓存断点标记).
   * 这段内容只用于摘要调用, 不参与工作消息压缩.
   */
  readonly systemMessages: readonly Message[];
  /** 摘要请求复用的 Tool 定义(同内容同顺序), 模型不得真正调用. */
  readonly tools: readonly LlmTool[];
  /** 摘要请求复用的 thinking 配置. */
  readonly thinking?: LlmThinking;
  /** 完整候选请求的本地估算, 包含工作消息以外的 System Prompt 和 Tool 定义. */
  readonly estimatedInputTokens: number;
  /** Provider 已明确报告超限时跳过阈值判断. */
  readonly force?: boolean;
  /**
   * 是否先跑 Micro. 手动 /compact 传 false, 因为 Micro 的替换不落库.
   */
  readonly micro?: boolean;
  readonly contextWindow: number;
  /** 当前模型的输出硬上限. null 或缺省表示未知. */
  readonly modelMaxOutput?: number | null;
  readonly signal?: AbortSignal;
  /** 过程事件出口. 事件属于 Session, 调用方负责补充 Turn 身份. */
  readonly emit?: (event: CompactEvent) => void;
  /**
   * 根 Turn 和手动 /compact 用它保存摘要
   * 保存成功后才发 compact_completed. 保存失败则发 compact_failed 并上抛.
   */
  readonly saveMacroSummary?: (
    summary: string,
    summarizedMessageCount: number,
  ) => void;
  /** 不提供时使用构造时的默认设置. */
  readonly settings?: Readonly<CompactSettings>;
}

/**
 * Compact 的唯一返回值
 */
export type CompactResult =
  | {
      readonly kind: 'unchanged';
      readonly messages: readonly Message[];
      /** 仅 Macro 尝试失败时携带, 未尝试的 unchanged 没有这个字段 */
      readonly failureDetail?: string;
    }
  | {
      readonly kind: 'micro';
      readonly messages: readonly Message[];
    }
  | {
      readonly kind: 'macro';
      readonly messages: readonly Message[];
      readonly beforeTokens: number;
      readonly afterTokens: number;
      readonly savedTokens: number;
      readonly durationMs: number;
      /** 摘要调用的最终 usage  */
      readonly usage: LlmTokenUsage;
      /**
       * 从输入数组开头起, 被最终摘要覆盖的消息数.
       * Compact 不持有 SQL Message ID, 调用方据此映射覆盖游标.
       */
      readonly summarizedMessageCount: number;
    };
