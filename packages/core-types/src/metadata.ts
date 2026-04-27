/**
 * 单轮交互的元数据结构与 Prompt 组装元数据。
 */

import type { ContextSource, RecallMeta } from "./memory.js";
import type { EmaMode } from "./modes.js";
import type { ToolCallMeta } from "./session.js";
import type { UsageView } from "./turns.js";

/** 单轮元信息 */
export interface EmaTurnMetadata {
  mode: EmaMode;
  sessionId: string;
  requestId: string;
  /** Trace ID，用于全链路追踪 */
  traceId: string;
  model: { provider: string; modelId: string };
  usage: UsageView;
  latencyMs: number;
  /**
   * 召回统计 —— 按 ContextSource 统一索引。
   *
   * 与 v0.4 的 {attachment?, memory?, narrative?} 不同，
   * V1 按实际来源分类：user_profile、rolling_summary、semantic_fact 等。
   */
  recalls: {
    /** 各来源的召回统计 */
    sources: Partial<Record<ContextSource, RecallMeta>>;
    /** 总 token 占用 */
    totalTokens: number;
    /** 是否触发压缩 */
    compactionTriggered: boolean;
  };
  toolCalls: ToolCallMeta[];
  safety: {
    sandboxMode: "strict" | "relaxed";
    fullAccessGranted: boolean;
    deniedCount: number;
  };
  live2d?: {
    expression?: string;
    motion?: string;
    mouthSyncMs?: number;
  };
}

/** Prompt 组装元数据（用于调试与前端展示） */
export interface PromptAssemblyMeta {
  /** 原始用户 query 的 hash */
  rawHash: string;
  /** 组装后 prompt 的 hash */
  assembledHash: string;
  /** 组装前 token 估算 */
  rawTokenEstimate: number;
  /** 组装后 token 估算 */
  assembledTokenEstimate: number;
  /** 各上下文块占比 */
  blockBreakdown: Array<{ source: string; charCount: number }>;
}
