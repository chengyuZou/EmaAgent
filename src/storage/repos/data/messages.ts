// 持久化 Session 消息，并提供 Turn 归属读取与压缩边界查询。
import type { SqliteDb } from '../../database/database.js';
import type { MessageId, SessionId, TurnId } from '@ema-agent/ids';

export type MessageRole = 'system' | 'user' | 'assistant';
const MESSAGE_TURN_READ_LIMIT = 50;

/** messages.kind 的数据库稳定枚举。 */
export type MessageKind =
  | 'normal'
  | 'tool_results'
  | 'summary'
  | 'narrative_context';

export interface MessageRow {
  id:          string;
  session_id:  string;
  turn_id:     string | null;
  role:        MessageRole;
  kind:        MessageKind;
  /** JSON 编码的 MessageBlocks—字符串字面量、AssistantBlock[] 或 UserBlock[]。 */
  blocks_json: string;
  interrupted: number;
  created_at:  number;
}

export interface MessageInsert {
  id:         MessageId;
  sessionId:  SessionId;
  turnId?:    TurnId;
  role:       MessageRole;
  kind?:      MessageKind;
  /** 预序列化的 JSON 字符串（传入前调 JSON.stringify(blocks)）。 */
  blocksJson: string;
  interrupted?: boolean;
  createdAt:  number;
}

export class MessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: MessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.sessionId,
        m.turnId ?? null,
        m.role,
        m.kind ?? 'normal',
        m.blocksJson,
        m.interrupted ? 1 : 0,
        m.createdAt,
      );
  }

  findById(id: MessageId): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listForSession(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(sessionId, limit) as MessageRow[];
  }

  listForTurn(turnId: TurnId): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at ASC, id ASC')
      .all(turnId) as MessageRow[];
  }

  /** 读取一组已限定 Turn 的消息，供历史窗口按时间正序展示。 */
  listForTurns(sessionId: SessionId, turnIds: readonly TurnId[]): MessageRow[] {
    if (turnIds.length === 0) return [];
    if (turnIds.length > MESSAGE_TURN_READ_LIMIT) {
      throw new RangeError(`message_turn_read_limit: ${turnIds.length}`);
    }
    const placeholders = turnIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND turn_id IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, ...turnIds) as MessageRow[];
  }

  markInterrupted(id: MessageId): void {
    this.db.prepare('UPDATE messages SET interrupted = 1 WHERE id = ?').run(id);
  }

  deleteForTurn(turnId: TurnId): void {
    this.db.prepare('DELETE FROM messages WHERE turn_id = ?').run(turnId);
  }

  /** Cursor 分页：created_at < before 的行，按最新优先。 */
  listBefore(sessionId: SessionId, before: number, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND created_at < ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, before, limit) as MessageRow[];
  }

  countForSession(sessionId: SessionId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  // ── Summary / compaction 边界辅助 ──────────────────────────────────

  /** 该 session 中最近一条 kind='summary' 的 message（若有）。 */
  findLastSummary(sessionId: SessionId): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ? AND kind = 'summary'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(sessionId) as MessageRow | undefined;
  }

  /**
   * 加载面向 LLM 的有界历史，最终按时间正序返回。
   *
   * - 无 summary：返回最新 `limit` 条消息。
   * - 有 summary：始终保留最新 summary，并返回其后最新的 `limit - 1` 条消息。
   *
   * 两层排序是刻意的：内层倒序利用索引截取最新 N 条，外层再恢复为
   * LLM 需要的正序。`id` 是同毫秒消息的稳定排序键。
   */
  listForSessionFromSummary(sessionId: SessionId, limit = 500): MessageRow[] {
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 500;

    return this.db
      .prepare(
        `WITH latest_summary AS (
           SELECT *
             FROM messages
            WHERE session_id = ? AND kind = 'summary'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         ),
         recent_messages AS (
           SELECT m.*
             FROM messages m
            WHERE m.session_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM latest_summary s WHERE s.id = m.id
              )
              AND (
                NOT EXISTS (SELECT 1 FROM latest_summary)
                OR EXISTS (
                  SELECT 1
                    FROM latest_summary s
                   WHERE m.created_at > s.created_at
                      OR (m.created_at = s.created_at AND m.id > s.id)
                )
              )
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT MAX(0, ? - (SELECT COUNT(*) FROM latest_summary))
         ),
         selected_messages AS (
           SELECT * FROM latest_summary
           UNION ALL
           SELECT * FROM recent_messages
         )
         SELECT *
           FROM selected_messages
          ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId, sessionId, boundedLimit) as MessageRow[];
  }
}
