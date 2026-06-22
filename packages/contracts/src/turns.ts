import type { SessionId, TurnId, TurnMode } from './ids.js';
import type { MessageContentPart, TurnAttachment } from './messages.js';

// ── POST /api/turns 的请求体 ──────────────────────────────────────────────────

/**
 * userInput 和 contentParts 至少要有一个（Zod schema 在路由层做 refine 校验）。
 * sessionId 省略时后端自动创建新 session 并返回生成的 sessionId。
 * providerId + model 省略时使用 model_bindings 里对应 mode 的绑定。
 * providerId 和 model 应成对出现——前端选择器选的是 (provider, model) 组合，
 * 因为同名模型可能存在于多个供应商下。
 */
export interface TurnRequest {
  sessionId?:    SessionId;             // 省略 → 自动创建新 session
  mode:          TurnMode;
  userInput?:    string;
  contentParts?: MessageContentPart[];
  attachments?:  TurnAttachment[];
  /** provider_configs.id — 本次 turn 使用的供应商实例。和 model 成对使用。 */
  providerId?:   string;
  /** 模型名。如果有 providerId，此模型必须在该供应商下已启用。 */
  model?:        string;
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

// ── 本轮统计（被 turn_completed SSE 事件引用） ────────────────────────────────
//
// 命名注意：这是"turn 终态摘要"不是 provider 的 usage 对象——token（账单）与
// durationMs（秒表）出身不同但消费场景 100% 重合，故同居一个类型。
// 曾名 UsageSummary，因名字暗示"纯 token 计量"导致 subagent_completed 事件
// 在外面重复携带过一次 durationMs——名不正则字段歪。

export interface TurnStats {
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
  durationMs:   number;
}