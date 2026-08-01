// 持久化后台 Shell 状态、完成通知领取和断电后的 interrupted 收口。

import type {
  BackgroundProcessId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export type BackgroundProcessStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'stopped'
  | 'interrupted';

export interface BackgroundProcessRow {
  id: BackgroundProcessId;
  session_id: SessionId;
  origin_turn_id: TurnId | null;
  tool_call_id: ToolCallId | null;
  command: string;
  description: string | null;
  cwd: string;
  status: BackgroundProcessStatus;
  timeout_ms: number;
  version: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  exit_code: number | null;
  termination_reason: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  output_truncated: 0 | 1;
  output_relative_path: string;
  completion_claimed_at: number | null;
  continuation_turn_id: TurnId | null;
  model_notified_at: number | null;
}

export interface BackgroundProcessInsert {
  id: BackgroundProcessId;
  sessionId: SessionId;
  originTurnId: TurnId;
  toolCallId: ToolCallId;
  command: string;
  description?: string;
  cwd: string;
  status: 'queued' | 'running';
  timeoutMs: number;
  outputRelativePath: string;
  createdAt: number;
  startedAt?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputTruncated?: boolean;
}

export interface BackgroundProcessTerminal {
  status: 'completed' | 'failed' | 'timedOut' | 'stopped' | 'interrupted';
  completedAt: number;
  exitCode?: number;
  terminationReason?: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
}

/** Storage 只实现原子状态转换；调度、公平队列和进程树生命周期由 Tools 管理。 */
export class BackgroundProcessesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(value: BackgroundProcessInsert): BackgroundProcessRow {
    return this.db.prepare(
      `INSERT INTO background_processes (
         id, session_id, origin_turn_id, tool_call_id, command, description, cwd,
         status, timeout_ms, created_at, started_at, stdout_bytes, stderr_bytes,
         output_truncated, output_relative_path
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      value.id,
      value.sessionId,
      value.originTurnId,
      value.toolCallId,
      value.command,
      value.description ?? null,
      value.cwd,
      value.status,
      value.timeoutMs,
      value.createdAt,
      value.startedAt ?? null,
      value.stdoutBytes ?? 0,
      value.stderrBytes ?? 0,
      value.outputTruncated ? 1 : 0,
      value.outputRelativePath,
    ) as BackgroundProcessRow;
  }

  findById(id: BackgroundProcessId): BackgroundProcessRow | undefined {
    return this.db.prepare(
      'SELECT * FROM background_processes WHERE id = ?',
    ).get(id) as BackgroundProcessRow | undefined;
  }

  listForSession(
    sessionId: SessionId,
    options: { status?: BackgroundProcessStatus; limit?: number } = {},
  ): BackgroundProcessRow[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    if (options.status) {
      return this.db.prepare(
        `SELECT * FROM background_processes
          WHERE session_id = ? AND status = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).all(sessionId, options.status, limit) as BackgroundProcessRow[];
    }
    return this.db.prepare(
      `SELECT * FROM background_processes
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(sessionId, limit) as BackgroundProcessRow[];
  }

  transitionToRunning(
    id: BackgroundProcessId,
    expectedVersion: number,
    startedAt: number,
  ): BackgroundProcessRow | undefined {
    return this.db.prepare(
      `UPDATE background_processes
          SET status = 'running',
              started_at = COALESCE(started_at, ?),
              version = version + 1
        WHERE id = ? AND version = ? AND status = 'queued'
        RETURNING *`,
    ).get(startedAt, id, expectedVersion) as BackgroundProcessRow | undefined;
  }

  finish(
    id: BackgroundProcessId,
    expectedVersion: number,
    terminal: BackgroundProcessTerminal,
  ): BackgroundProcessRow | undefined {
    return this.db.prepare(
      `UPDATE background_processes
          SET status = ?,
              completed_at = ?,
              exit_code = ?,
              termination_reason = ?,
              stdout_bytes = ?,
              stderr_bytes = ?,
              output_truncated = ?,
              version = version + 1
        WHERE id = ? AND version = ? AND status IN ('queued','running')
        RETURNING *`,
    ).get(
      terminal.status,
      terminal.completedAt,
      terminal.exitCode ?? null,
      terminal.terminationReason ?? null,
      terminal.stdoutBytes,
      terminal.stderrBytes,
      terminal.outputTruncated ? 1 : 0,
      id,
      expectedVersion,
    ) as BackgroundProcessRow | undefined;
  }

  recoverInterrupted(at: number): BackgroundProcessRow[] {
    return this.db.prepare(
      `UPDATE background_processes
          SET status = 'interrupted',
              completed_at = ?,
              termination_reason = 'Application stopped before the process completed',
              version = version + 1
        WHERE status IN ('queued','running')
        RETURNING *`,
    ).all(at) as BackgroundProcessRow[];
  }

  /**
   * 为同一 Session 的自然终态预留一个新 TurnId。continuation_turn_id 是软预留：
   * Turn 行尚未创建时不能建立 FK，但身份仍由业务层用 BackgroundProcessId 幂等校验。
   */
  claimCompletionBatch(
    sessionId: SessionId,
    continuationTurnId: TurnId,
    at: number,
    limit = 20,
  ): BackgroundProcessRow[] {
    const claim = this.db.transaction(() => {
      const existing = this.db.prepare(
        `SELECT * FROM background_processes
          WHERE session_id = ?
            AND continuation_turn_id IS NOT NULL
            AND model_notified_at IS NULL
          ORDER BY completed_at ASC, id ASC
          LIMIT ?`,
      ).all(sessionId, limit) as BackgroundProcessRow[];
      if (existing.length > 0) return existing;

      const candidates = this.db.prepare(
        `SELECT id FROM background_processes
          WHERE session_id = ?
            AND status IN ('completed','failed','timedOut')
            AND continuation_turn_id IS NULL
            AND model_notified_at IS NULL
          ORDER BY completed_at ASC, id ASC
          LIMIT ?`,
      ).all(sessionId, limit) as Array<{ id: BackgroundProcessId }>;
      if (candidates.length === 0) return [];

      const placeholders = candidates.map(() => '?').join(', ');
      this.db.prepare(
        `UPDATE background_processes
            SET completion_claimed_at = ?,
                continuation_turn_id = ?,
                version = version + 1
          WHERE id IN (${placeholders})
            AND continuation_turn_id IS NULL`,
      ).run(at, continuationTurnId, ...candidates.map(row => row.id));

      return this.db.prepare(
        `SELECT * FROM background_processes
          WHERE continuation_turn_id = ?
          ORDER BY completed_at ASC, id ASC`,
      ).all(continuationTurnId) as BackgroundProcessRow[];
    });
    return claim();
  }

  markCompletionDelivered(continuationTurnId: TurnId, at: number): number {
    return this.db.prepare(
      `UPDATE background_processes
          SET model_notified_at = ?,
              version = version + 1
        WHERE continuation_turn_id = ?
          AND model_notified_at IS NULL`,
    ).run(at, continuationTurnId).changes;
  }

  listSessionsWithPendingCompletions(limit = 100): SessionId[] {
    const rows = this.db.prepare(
      `SELECT session_id, MIN(completed_at) AS first_completed_at
         FROM background_processes
        WHERE status IN ('completed','failed','timedOut')
          AND model_notified_at IS NULL
        GROUP BY session_id
        ORDER BY first_completed_at ASC, session_id ASC
        LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 500)) as Array<{ session_id: SessionId }>;
    return rows.map(row => row.session_id);
  }
}
