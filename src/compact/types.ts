import type { SessionId, TurnId } from '@ema-agent/ids';
import type { Message } from '@ema-agent/llm';
import type { ExecutionProfile } from '@ema-agent/turn';
import type { CompactEvent } from './events.js';

/** 必须启用自动压缩 */
export interface CompactSettings {
  enabled: boolean;
  bufferTokens: number;
  defaultReservedOutputTokens: number;
  maximumReservedOutputTokens: number;
  keepRecentToolResults: number;
  maximumConsecutiveFailures: number;
}

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  enabled: true,
  bufferTokens: 13_000,
  defaultReservedOutputTokens: 8_000,
  maximumReservedOutputTokens: 20_000,
  keepRecentToolResults: 6,
  maximumConsecutiveFailures: 3,
};

export interface CompactRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly executionProfile: ExecutionProfile;
  /** 仅包含允许被改写的历史；System Prompt、当前 Turn 与临时召回不在这里。 */
  readonly history: readonly Message[];
  /** Context 对完整候选请求的最新估算；可以使用最近真实 Usage 加本轮增量校准。 */
  readonly estimatedInputTokens: number;
  /** Provider 已明确报告超限时跳过阈值判断，强制尝试安全压缩。 */
  readonly force?: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly providerId: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly emit?: (event: CompactEvent) => void;
  /** 根 Turn 启动时冻结的设置；不提供时使用构造时默认值。 */
  readonly settings?: Readonly<CompactSettings>;
}

interface CompactResultBase {
  readonly history: Message[];
  readonly microCleared: number;
  /** 固定输入与历史的合计估算。 */
  readonly beforeTokens: number;
  /** 固定输入与返回历史的合计估算。 */
  readonly afterTokens: number;
  readonly savedTokens: number;
}

export type CompactResult =
  | (CompactResultBase & {
      readonly status: 'not_needed';
      readonly reason: 'disabled' | 'below_threshold' | 'empty_history';
    })
  | (CompactResultBase & {
      readonly status: 'skipped';
      readonly reason: 'circuit_open';
      readonly detail: string;
    })
  | (CompactResultBase & {
      readonly status: 'failed';
      readonly reason: 'macro_failed' | 'budget_exceeded';
      readonly detail: string;
    })
  | (CompactResultBase & {
      readonly status: 'completed';
      readonly method: 'micro';
    })
  | (CompactResultBase & {
      readonly status: 'completed';
      readonly method: 'macro';
      /** TurnExecution 可以持久化这份摘要；Compact 不写 Session。 */
      readonly summary: string;
    });
