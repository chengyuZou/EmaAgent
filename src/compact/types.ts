import type { Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn-terms';
import type { CompactSettings } from './settings.js';
import type { CompactEvent } from './events.js';

// 设置接口(CompactSettings)与默认快照(DEFAULT_COMPACT_SETTINGS)统一在 settings.ts。

export interface CompactRequest {
  readonly sessionId: string;
  readonly executionProfile: ExecutionProfile;
  /** 仅包含允许被改写的历史；System Prompt、当前 Turn 与临时召回不在这里。 */
  readonly history: readonly Message[];
  /** Context 对完整候选请求的最新估算；可以使用最近真实 Usage 加本轮增量校准。 */
  readonly estimatedInputTokens: number;
  /** Provider 已明确报告超限时跳过阈值判断，强制尝试安全压缩。 */
  readonly force?: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  /** 过程事件出口（Session 域，无 Turn 身份）；投影为谁的事件由调用方决定。 */
  readonly onEvent?: (event: CompactEvent) => void;
  /** 根 Turn 启动时冻结的设置；不提供时使用构造时默认值。 */
  readonly settings?: Readonly<CompactSettings>;
}

/**
 * Compact 的唯一返回值。所有分支都返回下一次装配应使用的 history；只有 Macro
 * 额外返回需要由 TurnExecution 持久化的摘要事实。
 */
export type CompactResult =
  | {
      readonly kind: 'unchanged';
      readonly history: readonly Message[];
    }
  | {
      readonly kind: 'micro';
      readonly history: readonly Message[];
    }
  | {
      readonly kind: 'macro';
      readonly history: readonly Message[];
      /** 已经按最终历史预算裁剪过的摘要正文，持久化时必须使用这一份。 */
      readonly summary: string;
      /** 被摘要替换的模型历史条数；接线层据此映射稳定的 SQL 截止游标。 */
      readonly compactedMessageCount: number;
    };
