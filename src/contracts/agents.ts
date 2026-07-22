import type { SessionId, ToolCallId, TurnId } from './ids.js';

// ── AgentKind ─────────────────────────────────────────────────────────────────
//
// Determines how a sub-agent's initial context is constructed.
// Lives in contracts (not in @ema-agent/tool) so event types in events.ts can
// reference it without creating a circular dependency.
//
// 'coordinator-worker' (expanded tool permissions) is deferred to V2.

export type AgentKind = 'subagent' | 'fork';

// ── 工具执行日志 ─────────────────────────────────────────────────────────────

/**
 * 一次工具调用在持久化执行日志中的生命周期状态。
 *
 * `outcome_unknown` 只用于进程在工具已开始后异常退出的场景：此时外部副作用
 * 可能已经发生，系统必须禁止自动重放，并把最终结果交给用户确认。
 */
export type ToolExecutionStatus =
  | 'prepared'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

/** 可跨包传递的工具执行审计记录。 */
export interface ToolExecutionRecord {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  status: ToolExecutionStatus;
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}
