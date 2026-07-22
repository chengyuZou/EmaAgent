import type {
  SessionId,
  TurnId,
  MessageId,
  BranchId,
  TurnMode,
  TurnStatus,
  MessageRole,
  MessageKind,
  MessageBlocks,
  AssistantBlock,
  UserBlock,
} from '@ema-agent/contracts';
import type {
  ExecutionProfile,
  NarrativePolicy,
  TurnTriggerType,
} from '@ema-agent/turn';

// ── Domain objects (camelCase, parsed) ───────────────────────────────────────

export interface Branch {
  id:               BranchId;
  sessionId:        SessionId;
  parentBranchId:   BranchId | null;
  forkFromTurnId:   TurnId   | null;
  createdAt:        number;
}

export interface BranchSibling {
  branchId:  BranchId;
  /** 1-based position in the sibling list (for "< 1/2 >" display). */
  position:  number;
  total:     number;
  isActive:  boolean;
  createdAt: number;
}

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
  activeBranchId:   BranchId | null;
  runningTurnCount: number;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 旧前端退役前的只读显示投影，不再持久化。 */
  lastMode: TurnMode;
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
  branchId:     BranchId | null;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  /** 旧事件与前端退役前的只读显示投影，不再持久化。 */
  mode: TurnMode;
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

export interface ForkMessageInput {
  sessionId:     SessionId;
  /** The last turn to include in the parent branch before the fork diverges. */
  fromTurnId:    TurnId;
}

export interface SwitchBranchInput {
  sessionId: SessionId;
  /** Pass null to reset to root (only valid before any fork — after first fork use root branch ID). */
  branchId:  BranchId | null;
}

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

// Re-export for consumers who build block arrays
export type { MessageBlocks, AssistantBlock, UserBlock };
