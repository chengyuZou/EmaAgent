import type { SqliteDb } from '../database.js';
import type { MessageId, SessionId, TurnId, MessageRole, MessageKind } from '@ema-agent/contracts';

export interface MessageRow {
  id: string;
  session_id: string;
  turn_id: string | null;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  interrupted: number;
  created_at: number;
  meta_json: string;
}

export interface MessageInsert {
  id: MessageId;
  sessionId: SessionId;
  turnId?: TurnId;
  role: MessageRole;
  kind?: MessageKind;
  content: string;
  toolCallsJson?: string;
  toolCallId?: string;
  interrupted?: boolean;
  createdAt: number;
  metaJson?: string;
}

export class MessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: MessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, content, tool_calls_json, tool_call_id,
            interrupted, created_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.sessionId,
        m.turnId ?? null,
        m.role,
        m.kind ?? 'normal',
        m.content,
        m.toolCallsJson ?? null,
        m.toolCallId ?? null,
        m.interrupted ? 1 : 0,
        m.createdAt,
        m.metaJson ?? '{}',
      );
  }

  findById(id: MessageId): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listForSession(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
      )
      .all(sessionId, limit) as MessageRow[];
  }

  listForTurn(turnId: TurnId): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at ASC')
      .all(turnId) as MessageRow[];
  }

  markInterrupted(id: MessageId): void {
    this.db.prepare('UPDATE messages SET interrupted = 1 WHERE id = ?').run(id);
  }

  deleteForTurn(turnId: TurnId): void {
    this.db.prepare('DELETE FROM messages WHERE turn_id = ?').run(turnId);
  }

  countForSession(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }
}
