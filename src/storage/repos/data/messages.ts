// 持久化 Session 消息，并提供 Turn 归属读取与压缩边界查询。
import type { SqliteDb } from '../../database/database.js';

export type MessageRole = 'system' | 'user' | 'assistant';
const MESSAGE_TURN_READ_LIMIT = 50;

/** messages.kind 的数据库稳定枚举。 */
export type MessageKind =
  | 'normal'
  | 'tool_results'
  | 'summary'
  | 'reminder';

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
  /** 仅 summary 行非空：摘要覆盖截止点（含该消息）。 */
  summarized_through_message_id: string | null;
}

export interface MessageInsert {
  id:         string;
  sessionId:  string;
  turnId?:    string;
  role:       MessageRole;
  kind?:      MessageKind;
  /** 预序列化的 JSON 字符串（传入前调 JSON.stringify(blocks)）。 */
  blocksJson: string;
  interrupted?: boolean;
  createdAt:  number;
  /** 仅 kind='summary'：摘要覆盖截止消息 id。 */
  summarizedThroughMessageId?: string;
}

export class MessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: MessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at,
            summarized_through_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        m.summarizedThroughMessageId ?? null,
      );
  }

  findById(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listForSession(sessionId: string, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(sessionId, limit) as MessageRow[];
  }

  listForTurn(turnId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY created_at ASC, id ASC')
      .all(turnId) as MessageRow[];
  }

  /** 读取一组已限定 Turn 的消息，供历史窗口按时间正序展示。 */
  listForTurns(sessionId: string, turnIds: readonly string[]): MessageRow[] {
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

  markInterrupted(id: string): void {
    this.db.prepare('UPDATE messages SET interrupted = 1 WHERE id = ?').run(id);
  }

  /** 覆盖整条消息的 blocks_json（流式续写/追加 tool_use 用）。返回受影响行数。 */
  updateBlocks(id: string, blocksJson: string): number {
    return this.db
      .prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run(blocksJson, id).changes;
  }

  deleteForTurn(turnId: string): void {
    this.db.prepare('DELETE FROM messages WHERE turn_id = ?').run(turnId);
  }

  /** Cursor 分页：created_at < before 的行，按最新优先。 */
  listBefore(sessionId: string, before: number, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND created_at < ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, before, limit) as MessageRow[];
  }

  countForSession(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  // ── Summary / compaction 边界辅助 ──────────────────────────────────

  /** 该 session 中最近一条 kind='summary' 的 message（若有）。 */
  findLastSummary(sessionId: string): MessageRow | undefined {
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
   * - 有 summary：保留最新 summary，并返回覆盖截止游标之后最新的消息。
   *   边界取游标消息（summarized_through_message_id）的位置，不是 summary 自己的
   *   插入时间——否则活跃 Turn 在摘要生成期间写入的 reminder/用户消息会被错误吞掉。
   *   游标缺失时退回 summary 自身位置（写入路径保证非空，这只是 SQL 兜底）。
   *
   * 两层排序是刻意的：内层倒序利用索引截取最新 N 条，外层再恢复为
   * LLM 需要的正序。`id` 是同毫秒消息的稳定排序键。
   */
  listForSessionFromSummary(sessionId: string, limit = 500): MessageRow[] {
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
         coverage_boundary AS (
           SELECT COALESCE(
                    (SELECT m.created_at
                       FROM messages m
                       JOIN latest_summary s
                         ON m.id = s.summarized_through_message_id),
                    (SELECT s.created_at FROM latest_summary s)
                  ) AS created_at,
                  COALESCE(
                    (SELECT m.id
                       FROM messages m
                       JOIN latest_summary s
                         ON m.id = s.summarized_through_message_id),
                    (SELECT s.id FROM latest_summary s)
                  ) AS id
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
                    FROM coverage_boundary b
                   WHERE m.created_at > b.created_at
                      OR (m.created_at = b.created_at AND m.id > b.id)
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
         -- 展示顺序：summary 顶替最旧的历史段必须排第一；未覆盖消息可能先于摘要写入，
         -- 纯按 created_at 排会把它们错误地放到 summary 前面。
         SELECT *
           FROM selected_messages
          ORDER BY CASE WHEN id = (SELECT id FROM latest_summary) THEN 0 ELSE 1 END,
                   created_at ASC, id ASC`,
      )
      .all(sessionId, sessionId, boundedLimit) as MessageRow[];
  }
}
