import type { SqliteDb } from '../database.js';
import type { SessionId, MessageId } from '@ema-agent/contracts';

// ── 类型─────────────────────────────────────────────────────────────────────

export interface SessionNoteRow {
  session_id:             string;
  body:                   string;
  last_message_id:        string | null;
  tokens_at_last_update:  number;
  updated_at:             number;
}

export interface SessionNoteUpsert {
  sessionId:           SessionId;
  body:                string;
  lastMessageId?:      MessageId;
  tokensAtLastUpdate:  number;
  updatedAt:           number;
}

export interface SessionNotesStats {
  total_sessions: number;
  total_chars: number | null;
}

// ── Repo ──────────────────────────────────────────────────────────────────────

/**
 * Layer-1 session note - 每个 session 一行。body 是 JSON 编码的
 * SessionNoteEntry[]，由 memory 包管理。每个 entry.delta 是 markdown；
 * 调用方在注入 LLM context 前必须渲染 JSON body。
 */
export class SessionNotesRepo {
  constructor(private readonly db: SqliteDb) {}

  upsert(n: SessionNoteUpsert): void {
    this.db
      .prepare(
        `INSERT INTO session_notes
           (session_id, body, last_message_id, tokens_at_last_update, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           body                   = excluded.body,
           last_message_id        = excluded.last_message_id,
           tokens_at_last_update  = excluded.tokens_at_last_update,
           updated_at             = excluded.updated_at`,
      )
      .run(
        n.sessionId, n.body,
        n.lastMessageId ?? null,
        n.tokensAtLastUpdate,
        n.updatedAt,
      );
  }

  findBySession(sessionId: SessionId): SessionNoteRow | undefined {
    return this.db
      .prepare('SELECT * FROM session_notes WHERE session_id = ?')
      .get(sessionId) as SessionNoteRow | undefined;
  }

  stats(): SessionNotesStats {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total_sessions,
                SUM(LENGTH(body)) AS total_chars
           FROM session_notes`,
      )
      .get() as SessionNotesStats;
  }

  delete(sessionId: SessionId): void {
    this.db.prepare('DELETE FROM session_notes WHERE session_id = ?').run(sessionId);
  }
}
