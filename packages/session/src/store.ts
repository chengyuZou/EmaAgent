import crypto from 'node:crypto';
import {
  SessionsRepo,
  TurnsRepo,
  MessagesRepo,
  type SessionRow,
  type TurnRow,
  type MessageRow,
} from '@ema-agent/storage';
import {
  type SessionId,
  type TurnId,
  type MessageId,
  type CharacterCardId,
  asSessionId,
  asTurnId,
  asMessageId,
} from '@ema-agent/contracts';
import type { Database } from '@ema-agent/storage';
import type { MessageContentPart } from '@ema-agent/contracts';
import { RunRegistry } from './run-registry.js';
import type {
  Session,
  Turn,
  Message,
  ToolCall,
  CreateSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ListSessionsInput,
  ListMessagesInput,
} from './types.js';

// ── Row → domain object converters (module-private) ──────────────────────────

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    characterCardId: row.character_card_id as CharacterCardId,
    workspaceRoot: row.workspace_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
  };
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id as TurnId,
    sessionId: row.session_id as SessionId,
    mode: row.mode,
    agentSubMode: row.agent_sub_mode,
    status: row.status,
    userInput: row.user_input,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    iterations: row.iterations,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    costUsd: row.cost_usd,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
  };
}

function toMessage(row: MessageRow): Message {
  let toolCalls: ToolCall[] | null = null;
  if (row.tool_calls_json) {
    try {
      toolCalls = JSON.parse(row.tool_calls_json) as ToolCall[];
    } catch {
      toolCalls = null;
    }
  }

  // content is stored as plain text for normal messages,
  // or as JSON-serialized MessageContentPart[] for multimodal messages.
  let content: string | MessageContentPart[];
  try {
    const parsed = JSON.parse(row.content);
    content = Array.isArray(parsed) ? (parsed as MessageContentPart[]) : row.content;
  } catch {
    content = row.content;
  }

  return {
    id: row.id as MessageId,
    sessionId: row.session_id as SessionId,
    turnId: row.turn_id as TurnId | null,
    role: row.role,
    kind: row.kind,
    content,
    toolCalls,
    toolCallId: row.tool_call_id,
    interrupted: row.interrupted === 1,
    createdAt: row.created_at,
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
  };
}

// ── SessionStore ──────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
}

/**
 * SessionStore — single Façade for all session/turn/message state.
 *
 * Concurrency contract:
 *   One session allows at most ONE running turn at a time.
 *   startTurn() enforces this via RunRegistry (in-memory) + DB heal on startup.
 *   Multiple sessions can have concurrent running turns independently.
 */
export class SessionStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo: TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly registry: RunRegistry;
  /** Monotonically increasing clock — ensures created_at is unique even for sub-ms bursts. */
  private lastTs = 0;

  constructor({ db }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.registry     = new RunRegistry();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Returns a timestamp that is guaranteed to be strictly greater than the
   * last one returned from this instance. Prevents cursor-pagination breakage
   * when multiple records are inserted in the same millisecond.
   */
  private nextTs(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  // ── Session ─────────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput = {}): Session {
    const id  = asSessionId(crypto.randomUUID());
    const now = this.nextTs();
    this.sessionsRepo.insert({
      id,
      title:           input.title           ?? '新对话',
      characterCardId: input.characterCardId ?? ('ema' as CharacterCardId),
      workspaceRoot:   input.workspaceRoot,
      createdAt:       now,
      updatedAt:       now,
    });
    return this.requireSession(id);
  }

  getSession(id: SessionId): Session {
    return this.requireSession(id);
  }

  listSessions(input: ListSessionsInput = {}): Session[] {
    const rows = this.sessionsRepo.listActive(input.limit ?? 50, input.offset ?? 0);
    return rows.map(toSession);
  }

  updateTitle(id: SessionId, title: string): void {
    this.sessionsRepo.updateTitle(id, title, Date.now());
  }

  archiveSession(id: SessionId): void {
    this.sessionsRepo.archive(id, Date.now());
  }

  deleteSession(id: SessionId): void {
    this.registry.clear(id);
    this.sessionsRepo.delete(id);  // cascades to turns + messages via FK
  }

  // ── Turn ────────────────────────────────────────────────────────────────────

  /**
   * Create and immediately start a new turn for the session.
   *
   * Returns the Turn record AND an AbortSignal — pass the signal to
   * llm.stream() so Stop propagates without extra wiring.
   *
   * Throws 'session_busy' if a turn is already running for this session.
   */
  startTurn(input: StartTurnInput): { turn: Turn; signal: AbortSignal } {
    if (this.registry.isRunning(input.sessionId)) {
      throw new Error('session_busy: a turn is already running for this session');
    }

    const now = Date.now();

    // Heal stale 'running' rows left by a previous process crash.
    // better-sqlite3 is sync, so this + insert below are effectively atomic.
    this.turnsRepo.abortStale(input.sessionId, now);

    const turnId = asTurnId(crypto.randomUUID());
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      mode:         input.mode,
      agentSubMode: input.agentSubMode,
      userInput:    input.userInput,
      startedAt:    now,
    });
    this.turnsRepo.setRunning(turnId);
    this.sessionsRepo.touch(input.sessionId, now);

    const signal = this.registry.register(input.sessionId, turnId);
    return { turn: this.requireTurn(turnId), signal };
  }

  completeTurn(turnId: TurnId, usage: CompleteTurnInput = {}): void {
    const turn = this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:             'completed',
      completedAt:        Date.now(),
      usageInputTokens:   usage.usageInputTokens,
      usageOutputTokens:  usage.usageOutputTokens,
      costUsd:            usage.costUsd,
      iterations:         usage.iterations,
    });
    this.registry.clear(turn.sessionId);
  }

  failTurn(turnId: TurnId, errorCode: string, errorMessage?: string): void {
    const turn = this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:       'failed',
      completedAt:  Date.now(),
      errorCode,
      errorMessage,
    });
    this.registry.clear(turn.sessionId);
  }

  /**
   * Abort a running turn — fires the AbortSignal so the LLM stream stops,
   * then marks the turn as aborted in the DB.
   */
  abortTurn(sessionId: SessionId, turnId: TurnId): void {
    this.registry.abort(sessionId);   // signals AbortController → stream stops
    this.turnsRepo.complete(turnId, {
      status:      'aborted',
      completedAt: Date.now(),
    });
    this.registry.clear(sessionId);
  }

  getTurn(id: TurnId): Turn | undefined {
    const row = this.turnsRepo.findById(id);
    return row ? toTurn(row) : undefined;
  }

  getActiveTurn(sessionId: SessionId): Turn | undefined {
    const turnId = this.registry.getActiveTurnId(sessionId);
    if (!turnId) return undefined;
    return this.getTurn(turnId);
  }

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.turnsRepo.listForSession(sessionId, limit).map(toTurn);
  }

  // ── Message ─────────────────────────────────────────────────────────────────

  appendMessage(input: AppendMessageInput): Message {
    const id  = asMessageId(crypto.randomUUID());
    const now = this.nextTs();
    // Serialize multimodal content arrays to JSON for TEXT column storage.
    const content = Array.isArray(input.content)
      ? JSON.stringify(input.content)
      : input.content;
    this.messagesRepo.insert({
      id,
      sessionId:    input.sessionId,
      turnId:       input.turnId,
      role:         input.role,
      kind:         input.kind ?? 'normal',
      content,
      toolCallsJson: input.toolCalls ? JSON.stringify(input.toolCalls) : undefined,
      toolCallId:   input.toolCallId,
      interrupted:  input.interrupted ?? false,
      createdAt:    now,
    });
    return this.requireMessage(id);
  }

  markMessageInterrupted(id: MessageId): void {
    this.messagesRepo.markInterrupted(id);
  }

  /**
   * Load message history for LLM context — chronological order, last N messages.
   * Phase 2: simple limit. Phase 3+: MemoryPlanner handles token budgeting.
   */
  loadHistory(sessionId: SessionId, limit = 100): Message[] {
    return this.messagesRepo.listForSession(sessionId, limit).map(toMessage);
  }

  /**
   * Cursor-based list for the frontend chat UI.
   * Returns messages newest-first; pass the last item's createdAt as `before`
   * to load older messages (scroll-up pagination).
   */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit = input.limit ?? 50;

    if (input.before === undefined) {
      // First page: most recent N messages, reversed to newest-first
      return this.messagesRepo.listForSession(sessionId, limit).reverse().map(toMessage);
    }

    return this.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private requireSession(id: SessionId): Session {
    const row = this.sessionsRepo.findById(id);
    if (!row) throw new Error(`session_not_found: ${id}`);
    return toSession(row);
  }

  private requireTurn(id: TurnId): Turn {
    const row = this.turnsRepo.findById(id);
    if (!row) throw new Error(`turn_not_found: ${id}`);
    return toTurn(row);
  }

  private requireMessage(id: MessageId): Message {
    const row = this.messagesRepo.findById(id);
    if (!row) throw new Error(`message_not_found: ${id}`);
    return toMessage(row);
  }
}