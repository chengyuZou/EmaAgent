import type { TurnMode, AgentSubMode, MessageRole } from './ids.js';
import type { MessageKind, MessageBlocks, TurnAttachment } from './messages.js';

// ── REST wire formats ─────────────────────────────────────────────────────────
//
// Single source of truth for the JSON shapes that cross the HTTP boundary
// between apps/core routes and the frontend api/ layer. ALL wire types live
// in this file — do not scatter them next to their domain types.
//
// Rules:
//   - Backend routes annotate their response payloads with these types
//     (`satisfies` / return-type annotations) so a drifting field fails the
//     build on the producer side.
//   - Frontend api modules import these types directly — NEVER hand-copy
//     "matching" interfaces (two sources of truth always drift).
//   - Plain `string` here, not branded ids: wire types describe JSON, and
//     branded types (SessionId etc.) are assignable to string so producers
//     type-check without casts. Consumers re-brand at the api layer if needed.

export interface SessionWire {
  id:               string;
  title:            string;
  characterCardId:  string;
  workspaceRoots:   string[];
  createdAt:        number;
  updatedAt:        number;
  archivedAt:       number | null;
  pinned:           boolean;
  pinnedAt:         number | null;
  groupLabel:       string | null;
  parentSessionId:  string | null;
  runningTurnCount: number;
  meta:             Record<string, unknown>;
  lastMode:         TurnMode | null;
  lastSubMode:      AgentSubMode | null;
}

export interface SessionsListResult {
  sessions:    SessionWire[];
  nextCursor?: string;
}

export interface SessionsGroupedResult {
  pinned:   SessionWire[];
  byGroup:  Array<{ label: string; sessions: SessionWire[] }>;
  recent:   SessionWire[];
  archived: SessionWire[];
}

export interface ForkResult {
  sessionId:    string;
  messageCount: number;
}

/**
 * GET /api/sessions/:id/messages 的单条响应体。
 * 与 session 包的 Message 域对象逐字段对齐——后端路由用 `satisfies` 钉住，
 * 任何一侧漂移都在编译期报错。
 *
 * 前端根据 kind 决定渲染方式（见 messages.ts 的 MessageKind 表格）。
 * tool_results 消息不单独渲染气泡，前端用 toolUseId 把结果合并进
 * 对应的 assistant 气泡里的 tool_use block。
 */
export interface MessageWire {
  id:           string;
  sessionId:    string;
  /** 同一 turn 的多条消息（agent 多迭代）靠它分组重组装；重播音频也用它定位。 */
  turnId:       string | null;
  role:         MessageRole;
  kind:         MessageKind;
  blocks:       MessageBlocks;
  interrupted:  boolean;
  attachments?: TurnAttachment[];  // 只在 role='user' 消息上有值（预留，后端暂未填充）
  meta:         Record<string, unknown>; // 用于 kind='summary' 的压缩元信息，或其他扩展字段
  createdAt:    number;
}
