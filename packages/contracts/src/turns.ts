import type { SessionId, TurnId, TurnMode, AgentSubMode, TurnStatus } from './ids.js';
import type { MessageContentPart, TurnAttachment } from './messages.js';

// ── POST /api/turns 的请求体 ──────────────────────────────────────────────────

/**
 * userInput 和 contentParts 至少要有一个（Zod schema 在路由层做 refine 校验）。
 * sessionId 省略时后端自动创建新 session 并返回生成的 sessionId。
 * model 省略时使用 model_bindings 里对应 mode 的绑定。
 */
export interface TurnRequest {
  sessionId?:    SessionId;             // 省略 → 自动创建新 session
  mode:          TurnMode;
  agentSubMode?: AgentSubMode;
  userInput?:    string;
  contentParts?: MessageContentPart[];
  attachments?:  TurnAttachment[];
  model?:        string;                // 覆盖本次 turn 的模型绑定
  ttsEnabled?:   boolean;
}

// ── POST /api/turns 的响应体 ─────────────────────────────────────────────────

/**
 * 创建 turn 后立即返回，客户端拿到 turnId 去订阅 SSE。
 * sessionId 返回实际使用的 session（可能是刚创建的新 session）。
 */
export interface TurnCreatedResponse {
  turnId:    TurnId;
  sessionId: SessionId;
}

// ── 用量统计（被 turn_completed SSE 事件引用） ────────────────────────────────

export interface UsageSummary {
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
  durationMs:   number;
}