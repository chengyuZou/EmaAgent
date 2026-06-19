import type {
  SessionId,
  TurnId,
  MessageId,
  BranchId,
  CharacterCardId,
  TurnMode,
  AgentSubMode,
  TurnStatus,
  MessageRole,
  MessageKind,
  MessageBlocks,
  AssistantBlock,
  UserBlock,
} from '@ema-agent/contracts';

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
  characterCardId: CharacterCardId;
  workspaceRoots: string[];
  createdAt: number;
  /** Row metadata update time: title/group/pin/workspace/mode/meta edits. */
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
  lastMode:     TurnMode | null;
  lastSubMode:  AgentSubMode | null;
  lastViewedAt:   number | null;
  lastTurnStatus: TurnStatus | null;
  hasUnread:      boolean;
}

export interface Turn {
  id:           TurnId;
  sessionId:    SessionId;
  branchId:     BranchId | null;
  mode:         TurnMode;
  agentSubMode: AgentSubMode | null;
  status: TurnStatus;
  userInput: string;
  startedAt: number;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  iterations: number;
  usageInputTokens: number;
  usageOutputTokens: number;
  costUsd: number;
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
  characterCardId?: CharacterCardId;
  workspaceRoots?: string[];
  parentSessionId?: string;
}

export interface StartTurnInput {
  sessionId: SessionId;
  mode: TurnMode;
  agentSubMode?: AgentSubMode;
  userInput: string;
}

export interface CompleteTurnInput {
  usageInputTokens?: number;
  usageOutputTokens?: number;
  costUsd?: number;
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
   * Opaque cursor from the previous page's `nextCursor`. Format is internal
   * (`"<pinned>.<last_activity_at>"`), callers should NOT parse or construct it.
   *
   * Composite keyset cursor is required because the sort key is
   * `(pinned DESC, last_activity_at DESC)` — a single-field cursor would skip
   * items across the pinned/unpinned boundary.
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
