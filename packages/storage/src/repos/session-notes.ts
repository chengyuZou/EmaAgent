import type { SqliteDb } from '../database.js';
import type { SessionId, MessageId } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

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
 * Layer-1 session note - one row per session. Body is a JSON-encoded
 * SessionNoteEntry[] owned by the memory package. Each entry.delta is markdown;
 * callers must render the JSON body before injecting it into an LLM context.
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
