import type { TurnStatus } from '@ema-agent/turn';
import type { SessionId, TurnId, MessageId } from '@ema-agent/ids';
import type { MessageKind, MessageRole } from '@ema-agent/storage';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnTriggerType,
} from '@ema-agent/turn';
import type { MessageBlocks } from './message.js';

/** Session 聚合向其他模块提供的归属校验端口。 */
export interface SessionOwnershipFacade {
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void;
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void;
}

export type SessionOwnedEntity = 'artifact' | 'message' | 'turn';

// ── Domain objects (camelCase, parsed) ───────────────────────────────────────

export interface Session {
  id: SessionId;
  title: string;
  workspaceRoot:  string | null;
  createdAt: number;
  /** 行属性更新时间：标题、分组、置顶、Workspace 或执行偏好发生变化。 */
  updatedAt: number;
  /** Conversation activity time used for "recent sessions" ordering. */
  lastActivityAt: number;
  archivedAt: number | null;
  pinned:        boolean;
  pinnedAt:      number | null;
  groupLabel:    string | null;
  parentSessionId:  string   | null;
  runningTurnCount: number;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 用户希望该 Session 下一轮默认使用的供应商配置；null 表示使用系统默认选择。 */
  preferredProviderConfigId: string | null;
  /** 用户希望该 Session 下一轮默认使用的模型；null 表示使用系统默认选择。 */
  preferredModelId: string | null;
  lastViewedAt:   number | null;
  lastTurnStatus: TurnStatus | null;
  hasUnread:      boolean;
}

export interface Turn {
  id:           TurnId;
  sessionId:    SessionId;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  status: TurnStatus;
  userInput: string;
  startedAt: number;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  iterations: number;
  usageInputTokens: number;
  usageOutputTokens: number;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  turnId: TurnId | null;
  role: MessageRole;
  kind: MessageKind;
  /**
   * Parsed content blocks:
   * - system:    plain string
   * - user:      plain string | UserBlock[]  (UserBlock[] when has media or tool_results)
   * - assistant: AssistantBlock[]            (text / thinking / tool_use in original order)
   */
  blocks: MessageBlocks;
  interrupted: boolean;
  createdAt: number;
}

// ── Input types for SessionStore methods ─────────────────────────────────────

export interface CreateSessionInput {
  title?: string;
  workspaceRoot?:  string | null;
  parentSessionId?: string;
}

export interface StartTurnInput {
  sessionId: SessionId;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  userInput: string;
}

export interface CompleteTurnInput {
  usageInputTokens?: number;
  usageOutputTokens?: number;
  iterations?: number;
}

export interface AppendMessageInput {
  turnId: TurnId;
  sessionId: SessionId;
  role: MessageRole;
  kind?: MessageKind;
  blocks: MessageBlocks;
  interrupted?: boolean;
}

export interface ListSessionsInput {
  /** Max results per page. */
  limit?: number;
  /**
   * 上一页返回的不透明 V1 cursor。调用方只能原样回传，不能解析或构造。
   * 服务端使用 `(pinned DESC, last_activity_at DESC, id DESC)` 做稳定分页。
   */
  cursor?: string;
}

export interface ListSessionsOutput {
  sessions: Session[];
  /** Present when there are more results. Pass as `cursor` to the next request. */
  nextCursor?: string;
}

export interface ListMessagesInput {
  /** Cursor: load messages older than this timestamp (for UI pagination). */
  before?: number;
  limit?: number;
}

export interface SearchSessionsInput {
  query: string;
  limit?: number;
}

export interface SessionSearchHit {
  session:   Session;
  matchKind: 'title' | 'message';
  snippet:   string;
  messageId: MessageId | null;
  messageAt: number | null;
}

export interface SearchSessionsOutput {
  results: SessionSearchHit[];
}
