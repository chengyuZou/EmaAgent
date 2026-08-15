// 提供 Session 历史、Turn 导航索引和有界消息窗口读取。

import type { SessionId, TurnId } from '@ema-agent/ids';
import type {
  MessagesRepo,
  SessionsRepo,
  TurnIdPage,
  TurnIdPageCursor,
  TurnsRepo,
} from '@ema-agent/storage';
import type {
  ListMessagesInput,
  ListMessageWindowInput,
  ListTurnIndexInput,
  Message,
  MessageWindow,
  TurnIndexPage,
} from '../types.js';
import type { Turn } from '@ema-agent/turn';
import { SessionOwnershipError } from '../errors.js';
import { toMessage, toTurn } from '../persistence/rowMapping.js';

const DEFAULT_HISTORY_LIMIT = 500;
const TURN_INDEX_DEFAULT_LIMIT = 200;
const TURN_INDEX_MAX_LIMIT = 500;
const TURN_INDEX_PREVIEW_LENGTH = 180;
const MESSAGE_WINDOW_DEFAULT_BEFORE = 8;
const MESSAGE_WINDOW_DEFAULT_AFTER = 12;
const MESSAGE_WINDOW_MAX_SIDE = 25;
const MESSAGE_WINDOW_MAX_TOTAL = 40;

interface SessionHistoryDeps {
  sessionsRepo: SessionsRepo;
  turnsRepo: TurnsRepo;
  messagesRepo: MessagesRepo;
}

export class SessionHistory {
  constructor(private readonly deps: SessionHistoryDeps) {}

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.deps.turnsRepo.listForSession(sessionId, limit).map(toTurn);
  }

  listTurnIndex(sessionId: SessionId, input: ListTurnIndexInput = {}): TurnIndexPage {
    this.assertSessionExists(sessionId);
    const limit = normaliseIntegerLimit(
      input.limit,
      TURN_INDEX_DEFAULT_LIMIT,
      TURN_INDEX_MAX_LIMIT,
      'turn_index_limit',
    );
    const cursor = input.cursor ? decodeTurnIndexCursor(input.cursor) : undefined;
    const page = this.deps.turnsRepo.listForSessionPage(sessionId, cursor, limit);

    return {
      items: page.rows.map((row) => ({
        turnId: row.id as TurnId,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        status: row.status,
        triggerType: row.trigger_type,
        executionProfile: row.execution_profile,
        preview: formatTurnPreview(row.preview),
      })),
      nextCursor: page.nextCursor ? encodeTurnIndexCursor(page.nextCursor) : undefined,
    };
  }

  listMessageWindow(sessionId: SessionId, input: ListMessageWindowInput): MessageWindow {
    this.assertSessionExists(sessionId);
    this.assertTurnOwnership(sessionId, input.anchorTurnId);
    const beforeTurns = normaliseIntegerLimit(
      input.beforeTurns,
      MESSAGE_WINDOW_DEFAULT_BEFORE,
      MESSAGE_WINDOW_MAX_SIDE,
      'message_window_before',
      true,
    );
    const afterTurns = normaliseIntegerLimit(
      input.afterTurns,
      MESSAGE_WINDOW_DEFAULT_AFTER,
      MESSAGE_WINDOW_MAX_SIDE,
      'message_window_after',
      true,
    );
    if (beforeTurns + afterTurns > MESSAGE_WINDOW_MAX_TOTAL) {
      throw new Error('message_window_too_large');
    }

    const window = this.deps.turnsRepo.listWindowAround(
      sessionId,
      input.anchorTurnId,
      beforeTurns,
      afterTurns,
    );
    if (!window) throw new Error(`turn_not_found: ${input.anchorTurnId}`);

    const turnIds = window.rows.map((row) => row.id as TurnId);
    return {
      anchorTurnId: input.anchorTurnId,
      turns: window.rows.map(toTurn),
      messages: this.deps.messagesRepo.listForTurns(sessionId, turnIds).map(toMessage),
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    };
  }

  listTurnIdsPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    return this.deps.turnsRepo.listIdsForSessionPage(sessionId, cursor, limit);
  }

  loadHistory(sessionId: SessionId, limit = DEFAULT_HISTORY_LIMIT): Message[] {
    this.assertSessionExists(sessionId);
    return this.deps.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
  }

  loadMessagesForTurn(turnId: TurnId): Message[] {
    return this.deps.messagesRepo.listForTurn(turnId).map(toMessage);
  }

  /** 兼容聊天热尾读取；归档历史使用 Turn 索引与有界窗口。 */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit = input.limit ?? 50;
    this.assertSessionExists(sessionId);
    if (input.before === undefined) {
      return this.deps.messagesRepo.listForSession(sessionId, limit).map(toMessage);
    }
    return this.deps.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
  }

  private assertSessionExists(sessionId: SessionId): void {
    if (!this.deps.sessionsRepo.findById(sessionId)) {
      throw new Error(`session_not_found: ${sessionId}`);
    }
  }

  private assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void {
    const turn = this.deps.turnsRepo.findById(turnId);
    if (!turn) throw new Error(`turn_not_found: ${turnId}`);
    if (turn.session_id !== (sessionId as string)) {
      throw new SessionOwnershipError(
        `turn ${turnId} belongs to session ${turn.session_id}, not ${sessionId}`,
      );
    }
  }
}

function normaliseIntegerLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorCode: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(errorCode);
  }
  return resolved;
}

function formatTurnPreview(userInput: string): string {
  const preview = userInput.replace(/\s+/g, ' ').trim();
  if (preview.length <= TURN_INDEX_PREVIEW_LENGTH) return preview;
  return `${preview.slice(0, TURN_INDEX_PREVIEW_LENGTH - 1)}…`;
}

function encodeTurnIndexCursor(cursor: TurnIdPageCursor): string {
  return Buffer.from(JSON.stringify({
    a: cursor.createdAt,
    i: cursor.id,
  }), 'utf8').toString('base64url');
}

function decodeTurnIndexCursor(value: string): TurnIdPageCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as { a?: unknown; i?: unknown };
    if (
      !Number.isSafeInteger(parsed.a)
      || typeof parsed.i !== 'string'
      || parsed.i.length === 0
    ) {
      throw new Error('invalid');
    }
    return { createdAt: parsed.a as number, id: parsed.i };
  } catch {
    throw new Error('Invalid turn index cursor');
  }
}
