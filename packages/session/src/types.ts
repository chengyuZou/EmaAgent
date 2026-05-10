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
  MessageContentPart,
} from '@ema-agent/contracts';

// ── Domain objects (camelCase, parsed) ───────────────────────────────────────

export interface Session {
  id: SessionId;
  title: string;
  characterCardId: CharacterCardId;
  workspaceRoot: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
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

/** Parsed tool_call entry stored inside a Message. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Message {
  id: MessageId;
  sessionId: SessionId;
  turnId: TurnId | null;
  role: MessageRole;
  kind: MessageKind;
  /** Plain string for text-only messages; part array for multimodal (image) messages. */
  content: string | MessageContentPart[];
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  interrupted: boolean;
  createdAt: number;
  meta: Record<string, unknown>;
}

// ── Input types for SessionStore methods ─────────────────────────────────────

export interface CreateSessionInput {
  title?: string;
  characterCardId?: CharacterCardId;
  workspaceRoot?: string;
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
  content: string | MessageContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  interrupted?: boolean;
}

export interface ListSessionsInput {
  limit?: number;
  offset?: number;
}

export interface ListMessagesInput {
  /** Cursor: load messages older than this timestamp (for UI pagination). */
  before?: number;
  limit?: number;
}