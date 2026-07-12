import type { SqliteDb } from '../database.js';
import type { MessageId, SessionId, TurnId, BranchId, MessageRole, MessageKind } from '@ema-agent/contracts';

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
  meta_json:   string;
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
  metaJson?:  string;
}

export class MessagesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(m: MessageInsert): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
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
        m.metaJson ?? '{}',
      );
  }

  findById(id: MessageId): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  listForSession(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
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

  /** Cursor 分页：created_at < before 的行，按最新优先。 */
  listBefore(sessionId: SessionId, before: number, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND created_at < ?
         ORDER BY created_at DESC
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

  // ── Branch 段查询 ────────────────────────────────────────────────

  /**
   * 根 Branch 段：session 中 turn 属于 rootBranchId 的所有 message，
   * 加上无 turn_id 的 message（早于分支的 system/context 行）。
   * 可选地截止到 `beforeTurnStartedAt` 之前开始的 turn
   * （当该分支有子分支时设为 fork 点的 started_at）。
   */
  listForRootSegment(
    sessionId:           SessionId,
    rootBranchId:        BranchId,
    beforeTurnStartedAt?: number,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.session_id = ?
           AND (
             m.turn_id IS NULL
             OR m.turn_id IN (
               SELECT t.id FROM turns t
               WHERE t.branch_id = ?
                 AND (? IS NULL OR t.started_at <= ?)
             )
           )
         ORDER BY m.created_at ASC`,
      )
      .all(
        sessionId,
        rootBranchId,
        beforeTurnStartedAt ?? null,
        beforeTurnStartedAt ?? null,
      ) as MessageRow[];
  }

  /**
   * 非根 Branch 段：仅 turn 的 branch_id = branchId 的 message，
   * 可选地截止到 fork 点。不包含无 turn 的 message
   * （那些已在根段中）。
   */
  listForChildSegment(branchId: BranchId, beforeTurnStartedAt?: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM messages m
         WHERE m.turn_id IN (
           SELECT t.id FROM turns t
           WHERE t.branch_id = ?
             AND (? IS NULL OR t.started_at <= ?)
         )
         ORDER BY m.created_at ASC`,
      )
      .all(
        branchId,
        beforeTurnStartedAt ?? null,
        beforeTurnStartedAt ?? null,
      ) as MessageRow[];
  }

  // ── Summary / compaction 边界辅助 ──────────────────────────────────

  /** 该 session 中最近一条 kind='summary' 的 message（若有）。 */
  findLastSummary(sessionId: SessionId): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ? AND kind = 'summary'
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(sessionId) as MessageRow | undefined;
  }

  /**
   * 返回从最近一条 `summary` 行开始（含 summary 本身）的所有 message，
   * 上限 `limit`。无 summary 时等价于 listForSession()。
   * 供面向 LLM 的历史加载器使用，使 engine 自动只见 compaction 后的历史。
   */
  listForSessionFromSummary(sessionId: SessionId, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ?
            AND created_at >= COALESCE((
              SELECT MAX(created_at) FROM messages
               WHERE session_id = ? AND kind = 'summary'
            ), 0)
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(sessionId, sessionId, limit) as MessageRow[];
  }
}
