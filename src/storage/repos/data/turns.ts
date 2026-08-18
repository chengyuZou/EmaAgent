// 管理 Turn 的创建、状态流转、模型冻结、稳定分页和锚点窗口查询。
// Row 枚举由 storage 自持（SQL CHECK 的映射）；领域词汇归 @ema-agent/turn-terms 叶子，业务包在边界显式映射。
import type { SqliteDb } from '../../database/database.js';
import type { ExecutionProfileRow, NarrativePolicyRow } from './sessions.js';

/** turns.status 的 SQL CHECK 原样。 */
export type TurnStatusRow = 'running' | 'completed' | 'failed' | 'aborted';
/** turns.trigger_type 的 SQL CHECK 原样。 */
export type TurnTriggerTypeRow = 'userMessage' | 'backgroundProcessCompleted';

export interface TurnRow {
  id: string;
  session_id: string;
  status: TurnStatusRow;
  trigger_type: TurnTriggerTypeRow;
  execution_profile: ExecutionProfileRow;
  narrative_policy: NarrativePolicyRow;
  /** 操作开始冻结的模型选择；prepare 阶段解析成功前为 null。 */
  provider_id: string | null;
  model_id: string | null;
  iterations: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  created_at: number;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
}

export interface TurnInsert {
  id: string;
  sessionId: string;
  triggerType: TurnTriggerTypeRow;
  executionProfile: ExecutionProfileRow;
  narrativePolicy: NarrativePolicyRow;
  createdAt: number;
}

export interface TurnCompletion {
  status: TurnStatusRow;
  completedAt: number;
  errorCode?: string;
  errorMessage?: string;
  iterations?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
}

export interface TurnIdPageCursor {
  createdAt: number;
  id: string;
}

export interface TurnIdPage {
  ids: string[];
  nextCursor: TurnIdPageCursor | null;
}

export interface TurnIndexRow {
  id: string;
  trigger_type: TurnTriggerTypeRow;
  execution_profile: ExecutionProfileRow;
  status: TurnStatusRow;
  /** 首条 User Message 的正文预览；用户输入的唯一事实源是 Message。 */
  preview: string;
  provider_id: string | null;
  model_id: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface TurnPage {
  rows: TurnIndexRow[];
  nextCursor: TurnIdPageCursor | null;
}

export interface TurnWindow {
  rows: TurnRow[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export class TurnsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(t: TurnInsert): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, status, trigger_type,
            execution_profile, narrative_policy, created_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.sessionId,
        t.triggerType,
        t.executionProfile,
        t.narrativePolicy,
        t.createdAt,
      );
  }

  /** 操作开始冻结模型选择；prepare 解析成功后写入，整轮不再变。 */
  setModel(id: string, providerId: string, modelId: string): void {
    this.db
      .prepare('UPDATE turns SET provider_id = ?, model_id = ? WHERE id = ?')
      .run(providerId, modelId, id);
  }

  /**
   * 把一个已完成 turn 行复制到新 session(新 id)。用于 fork
   * 使 fork 出的 session 保留触发来源、Profile、模型冻结、
   * status、usage 与时序。
   */
  copyTurn(src: TurnRow, newSessionId: string, newId: string): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, status, trigger_type,
            execution_profile, narrative_policy, provider_id, model_id,
            iterations, usage_input_tokens, usage_output_tokens,
            created_at, completed_at, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId, newSessionId, src.status, src.trigger_type,
        src.execution_profile, src.narrative_policy, src.provider_id, src.model_id,
        src.iterations, src.usage_input_tokens, src.usage_output_tokens,
        src.created_at, src.completed_at, src.error_code, src.error_message,
      );
  }
  
  complete(id: string, c: TurnCompletion): void {
    this.db
      .prepare(
        `UPDATE turns SET
           status = ?, completed_at = ?, error_code = ?, error_message = ?,
           iterations = ?, usage_input_tokens = ?, usage_output_tokens = ?
         WHERE id = ?`,
      )
      .run(
        c.status,
        c.completedAt,
        c.errorCode ?? null,
        c.errorMessage ?? null,
        c.iterations ?? 0,
        c.usageInputTokens ?? 0,
        c.usageOutputTokens ?? 0,
        id,
      );
  }

  findById(id: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM turns WHERE id = ?').run(id);
  }

  listForSession(sessionId: string, limit = 100): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(sessionId, limit) as TurnRow[];
  }

  /** 按稳定复合游标读取 Turn 索引页，页面内部保持最新优先。 */
  listForSessionPage(
    sessionId: string,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnPage {
    const pageSize = Math.min(Math.max(limit, 1), 2_000);
    const rows = cursor
      ? this.db.prepare(`
          SELECT t.id, t.trigger_type, t.execution_profile, t.status,
                 COALESCE((
                   SELECT substr(ema_message_search_text(m.blocks_json), 1, 512)
                   FROM messages m
                   WHERE m.turn_id = t.id AND m.role = 'user' AND m.kind = 'normal'
                   ORDER BY m.created_at ASC, m.id ASC LIMIT 1
                 ), '') AS preview,
                 t.provider_id, t.model_id,
                 t.created_at, t.completed_at
          FROM turns t
          WHERE t.session_id = ?
            AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ?
        `).all(sessionId, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1)
      : this.db.prepare(`
          SELECT t.id, t.trigger_type, t.execution_profile, t.status,
                 COALESCE((
                   SELECT substr(ema_message_search_text(m.blocks_json), 1, 512)
                   FROM messages m
                   WHERE m.turn_id = t.id AND m.role = 'user' AND m.kind = 'normal'
                   ORDER BY m.created_at ASC, m.id ASC LIMIT 1
                 ), '') AS preview,
                 t.provider_id, t.model_id,
                 t.created_at, t.completed_at
          FROM turns t
          WHERE t.session_id = ?
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ?
        `).all(sessionId, pageSize + 1);
    const typedRows = rows as TurnIndexRow[];
    const pageRows = typedRows.slice(0, pageSize);
    const last = pageRows.at(-1);
    return {
      rows: pageRows,
      nextCursor: typedRows.length > pageSize && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
    };
  }

  /** 启动恢复等内部任务只读取 ID 与游标列，避免加载用户正文。 */
  listIdsForSessionPage(
    sessionId: string,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    const pageSize = Math.min(Math.max(limit, 1), 2_000);
    const rows = cursor
      ? this.db.prepare(`
          SELECT id, created_at FROM turns
          WHERE session_id = ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, cursor.createdAt, cursor.createdAt, cursor.id, pageSize + 1)
      : this.db.prepare(`
          SELECT id, created_at FROM turns
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, pageSize + 1);
    const typedRows = rows as Array<{ id: string; created_at: number }>;
    const pageRows = typedRows.slice(0, pageSize);
    const last = pageRows.at(-1);
    return {
      ids: pageRows.map((row) => row.id),
      nextCursor: typedRows.length > pageSize && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
    };
  }

  /**
   * 读取锚点 Turn 附近的有界窗口，返回顺序为旧到新。
   * 额外读取一行仅用于判断两侧是否还有数据。
   */
  listWindowAround(
    sessionId: string,
    anchorTurnId: string,
    beforeLimit: number,
    afterLimit: number,
  ): TurnWindow | undefined {
    const anchor = this.db
      .prepare('SELECT * FROM turns WHERE id = ? AND session_id = ?')
      .get(anchorTurnId, sessionId) as TurnRow | undefined;
    if (!anchor) return undefined;

    const olderRows = this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      sessionId,
      anchor.created_at,
      anchor.created_at,
      anchor.id,
      beforeLimit + 1,
    ) as TurnRow[];

    const newerRows = this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ?
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(
      sessionId,
      anchor.created_at,
      anchor.created_at,
      anchor.id,
      afterLimit + 1,
    ) as TurnRow[];

    return {
      rows: [
        ...olderRows.slice(0, beforeLimit).reverse(),
        anchor,
        ...newerRows.slice(0, afterLimit),
      ],
      hasOlder: olderRows.length > beforeLimit,
      hasNewer: newerRows.length > afterLimit,
    };
  }

  findRunning(sessionId: string): TurnRow | undefined {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1")
      .get(sessionId) as TurnRow | undefined;
  }

  abortStale(sessionId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE session_id = ? AND status = 'running'`,
      )
      .run(now, sessionId);
  }

  /** 进程崩溃恢复:把所有 session 中仍在运行的 turn 标记为 aborted。 */
  abortAllStale(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE status = 'running'`,
      )
      .run(now);
    return result.changes;
  }

}
