import type {
  SessionId,
  TurnId,
  MessageId,
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

export interface Session {
  id: SessionId;
  title: string;
  characterCardId: CharacterCardId;
  workspaceRoots: string[];
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  pinned:        boolean;
  pinnedAt:      number | null;
  groupLabel:    string | null;
  parentSessionId: string | null;
  runningTurnCount: number;
  meta: Record<string, unknown>;
}

export interface Turn {
  id: TurnId;
  sessionId: SessionId;
  mode: TurnMode;
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
  meta: Record<string, unknown>;
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
  meta: Record<string, unknown>;
}

// ── Input types for SessionStore methods ─────────────────────────────────────

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
  /** Cursor: return sessions with updated_at earlier than this timestamp. */
  cursor?: number;
}

export interface ListSessionsOutput {
  sessions: Session[];
  /** Present when there are more results. Pass as cursor to the next request. */
  nextCursor?: number;
}

export interface ListMessagesInput {
  /** Cursor: load messages older than this timestamp (for UI pagination). */
  before?: number;
  limit?: number;
}

// Re-export for consumers who build block arrays
export type { MessageBlocks, AssistantBlock, UserBlock };
