/**
 * 前后端流式事件协议。
 *
 * V1 默认用 SSE 承载这些语义事件；服务端内部可以先用 AsyncIterable<EmaStreamEvent>
 * 统一汇聚，再由 api-gateway 编码成 text/event-stream 或开发期 NDJSON。
 */

import type { ArtifactSummary, DiffSummary } from "./artifacts.js";
import type { EmaMode } from "./modes.js";
import type { RenderBlock } from "./response-markup.js";
import type { StepView, UsageView } from "./turns.js";
import type { UiErrorView } from "./errors.js";

/** 上下文预算快照，给 ContextRadarPane 展示。 */
export interface ContextBudgetView {
  maxTokens: number;
  usedTokens: number;
  reservedOutputTokens: number;
  compactionTriggered: boolean;
}

/** 单个上下文来源的可视化条目。 */
export interface ContextSourceView {
  id: string;
  source: "recent_messages" | "summary" | "memory" | "attachment" | "workspace" | "narrative" | "system";
  title: string;
  tokenEstimate: number;
  included: boolean;
}

/** 工具调用视图，权限弹窗和步骤流共用。 */
export interface ToolCallView {
  id: string;
  requestId: string;
  toolId: string;
  title: string;
  arguments: Record<string, unknown>;
  status: "requested" | "running" | "completed" | "failed" | "denied";
}

/** 工具输出视图，避免把原始 stdout/stderr 泄漏到 UI 结构之外。 */
export interface ToolOutputView {
  callId: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  summary?: string;
  durationMs?: number;
}

/** 权限请求视图。 */
export interface PermissionRequestView {
  id: string;
  requestId: string;
  scope: "once" | "session" | "always";
  toolId: string;
  title: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
  expiresAt?: number;
}

/** 权限决策。 */
export interface PermissionDecision {
  requestId: string;
  decision: "allow_once" | "allow_session" | "deny" | "always_deny";
  decidedAt: number;
}

/** Live2D 舞台只消费 cue，不直接读取复杂 agent 状态。 */
export interface StageCue {
  expression?: string;
  motion?: string;
  speaking?: boolean;
  mood?: "neutral" | "warm" | "thinking" | "focused" | "concerned" | "excited";
}

/** 流式事件联合类型。 */
export type EmaStreamEvent =
  | { type: "turn_started"; requestId: string; sessionId: string; mode: EmaMode; at: number }
  | { type: "context_snapshot"; requestId: string; budget: ContextBudgetView; sources: ContextSourceView[] }
  | { type: "output_text_delta"; requestId: string; blockId: string; delta: string; index: number }
  | { type: "render_block"; requestId: string; block: RenderBlock }
  | { type: "step_started"; requestId: string; step: StepView }
  | { type: "step_updated"; requestId: string; stepId: string; patch: Partial<StepView> }
  | { type: "tool_call_requested"; requestId: string; call: ToolCallView; permission?: PermissionRequestView }
  | { type: "tool_call_output"; requestId: string; callId: string; output: ToolOutputView }
  | { type: "artifact_upserted"; requestId: string; artifact: ArtifactSummary }
  | { type: "diff_ready"; requestId: string; artifactId: string; diff: DiffSummary }
  | { type: "permission_required"; requestId: string; request: PermissionRequestView }
  | { type: "permission_resolved"; requestId: string; requestIdResolved: string; decision: PermissionDecision }
  | { type: "stage_cue"; requestId: string; cue: StageCue }
  | { type: "usage_report"; requestId: string; usage: UsageView }
  | { type: "warning"; requestId: string; code: string; message: string }
  | { type: "turn_completed"; requestId: string; assistantMessageId: string; at: number }
  | { type: "turn_failed"; requestId: string; error: UiErrorView; retryable: boolean };

/** 兼容旧测试和旧 UI 命名的步骤事件别名。 */
export type StepEvent = StepView;
