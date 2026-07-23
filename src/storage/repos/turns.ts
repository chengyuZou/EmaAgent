// 管理 Turn 的创建、状态流转、稳定分页和锚点窗口查询。
import type { TurnStatus } from '@ema-agent/turn';
import type { SqliteDb } from '../database.js';
import type { TurnId, SessionId } from '@ema-agent/ids';
import type { ExecutionProfile, NarrativePolicy, TurnTriggerType } from '@ema-agent/turn';

export interface TurnRow {
  id: string;
  session_id: string;
  trigger_type: TurnTriggerType;
  execution_profile: ExecutionProfile;
  narrative_policy: NarrativePolicy;
  status: TurnStatus;
  user_input: string;
  started_at: number;
  completed_at: number | null;
  error_code: string | null;
  error_message: string | null;
  iterations: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
}

export interface TurnInsert {
  id: TurnId;
  sessionId: SessionId;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  userInput: string;
  startedAt: number;
}

export interface TurnCompletion {
  status: TurnStatus;
  completedAt: number;
  errorCode?: string;
  errorMessage?: string;
  iterations?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
}

export interface TurnIdPageCursor {
  startedAt: number;
  id: string;
}

export interface TurnIdPage {
  ids: string[];
  nextCursor: TurnIdPageCursor | null;
}

export interface TurnIndexRow {
  id: string;
  trigger_type: TurnTriggerType;
  execution_profile: ExecutionProfile;
  status: TurnStatus;
  user_input_preview: string;
  started_at: number;
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
           (id, session_id, trigger_type, execution_profile, narrative_policy,
            status, user_input, started_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        t.id,
        t.sessionId,
        t.triggerType,
        t.executionProfile,
        t.narrativePolicy,
        t.userInput,
        t.startedAt,
      );
  }

  /**
   * 把一个已完成 turn 行复制到新 session(新 id)。用于 fork
   * 使 fork 出的 session 保留触发来源、Profile、Narrative 策略、
   * status、usage 与时序。
   */
  copyTurn(src: TurnRow, newSessionId: SessionId, newId: TurnId): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, trigger_type, execution_profile, narrative_policy,
            status, user_input, started_at, completed_at,
            error_code, error_message, iterations, usage_input_tokens, usage_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId, newSessionId, src.trigger_type, src.execution_profile, src.narrative_policy,
        src.status, src.user_input, src.started_at, src.completed_at,
        src.error_code, src.error_message, src.iterations, src.usage_input_tokens,
        src.usage_output_tokens,
      );
  }

  setRunning(id: TurnId): void {
    this.db
      .prepare("UPDATE turns SET status = 'running' WHERE id = ?")
      .run(id);
  }

  complete(id: TurnId, c: TurnCompletion): void {
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

  findById(id: TurnId): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
  }

  delete(id: TurnId): void {
    this.db.prepare('DELETE FROM turns WHERE id = ?').run(id);
  }

  listForSession(sessionId: SessionId, limit = 100): TurnRow[] {
    return this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(sessionId, limit) as TurnRow[];
  }

  /** 按稳定复合游标读取 Turn，页面内部保持最新优先。 */
  listForSessionPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnPage {
    const pageSize = Math.min(Math.max(limit, 1), 2_000);
    const rows = cursor
      ? this.db.prepare(`
          SELECT id, trigger_type, execution_profile, status,
                 substr(user_input, 1, 512) AS user_input_preview,
                 started_at, completed_at
          FROM turns
          WHERE session_id = ?
            AND (started_at < ? OR (started_at = ? AND id < ?))
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, cursor.startedAt, cursor.startedAt, cursor.id, pageSize + 1)
      : this.db.prepare(`
          SELECT id, trigger_type, execution_profile, status,
                 substr(user_input, 1, 512) AS user_input_preview,
                 started_at, completed_at
          FROM turns
          WHERE session_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, pageSize + 1);
    const typedRows = rows as TurnIndexRow[];
    const pageRows = typedRows.slice(0, pageSize);
    const last = pageRows.at(-1);
    return {
      rows: pageRows,
      nextCursor: typedRows.length > pageSize && last
        ? { startedAt: last.started_at, id: last.id }
        : null,
    };
  }

  /** 启动恢复等内部任务只读取 ID 与游标列，避免加载用户正文。 */
  listIdsForSessionPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    const pageSize = Math.min(Math.max(limit, 1), 2_000);
    const rows = cursor
      ? this.db.prepare(`
          SELECT id, started_at FROM turns
          WHERE session_id = ?
            AND (started_at < ? OR (started_at = ? AND id < ?))
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, cursor.startedAt, cursor.startedAt, cursor.id, pageSize + 1)
      : this.db.prepare(`
          SELECT id, started_at FROM turns
          WHERE session_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, pageSize + 1);
    const typedRows = rows as Array<{ id: string; started_at: number }>;
    const pageRows = typedRows.slice(0, pageSize);
    const last = pageRows.at(-1);
    return {
      ids: pageRows.map((row) => row.id),
      nextCursor: typedRows.length > pageSize && last
        ? { startedAt: last.started_at, id: last.id }
        : null,
    };
  }

  /**
   * 读取锚点 Turn 附近的有界窗口，返回顺序为旧到新。
   * 额外读取一行仅用于判断两侧是否还有数据。
   */
  listWindowAround(
    sessionId: SessionId,
    anchorTurnId: TurnId,
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
        AND (started_at < ? OR (started_at = ? AND id < ?))
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all(
      sessionId,
      anchor.started_at,
      anchor.started_at,
      anchor.id,
      beforeLimit + 1,
    ) as TurnRow[];

    const newerRows = this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ?
        AND (started_at > ? OR (started_at = ? AND id > ?))
      ORDER BY started_at ASC, id ASC
      LIMIT ?
    `).all(
      sessionId,
      anchor.started_at,
      anchor.started_at,
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

  findRunning(sessionId: SessionId): TurnRow | undefined {
    return this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? AND status = 'running' LIMIT 1")
      .get(sessionId) as TurnRow | undefined;
  }

  abortStale(sessionId: SessionId, now: number): void {
    this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE session_id = ? AND status IN ('pending','running')`,
      )
      .run(now, sessionId);
  }

  /** 进程崩溃恢复:把所有 session 中仍在运行的 turn 标记为 aborted。 */
  abortAllStale(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE turns SET status = 'aborted', completed_at = ?
         WHERE status IN ('pending','running')`,
      )
      .run(now);
    return result.changes;
  }

}
