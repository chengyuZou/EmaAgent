// 持久化后台 Shell 状态, 并在应用重启时把遗留运行态收口为 interrupted.

import type { SqliteDb } from '../../database/database.js';

export type BackgroundProcessStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'stopped'
  | 'interrupted';

/** SQLite 原始行结构;备份链路按列名消费,不进入 Tools 运行态。 */
export interface BackgroundProcessRow {
  id: string;
  session_id: string;
  origin_turn_id: string | null;
  tool_call_id: string | null;
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
}

/** 提供给 Tools 端口的领域形状,不泄露 SQL 列名与 null。 */
interface StoredBackgroundProcess {
  id: string;
  sessionId: string;
  originTurnId?: string;
  toolCallId?: string;
  command: string;
  description?: string;
  cwd: string;
  status: BackgroundProcessStatus;
  timeoutMs: number;
  version: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  terminationReason?: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  outputRelativePath: string;
}

export interface BackgroundProcessInsert {
  id: string;
  sessionId: string;
  originTurnId: string;
  toolCallId: string;
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

  insert(value: BackgroundProcessInsert): StoredBackgroundProcess {
    const row = this.db.prepare(
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
    return fromSqlRow(row);
  }

  findById(id: string): StoredBackgroundProcess | undefined {
    const row = this.db.prepare(
      'SELECT * FROM background_processes WHERE id = ?',
    ).get(id) as BackgroundProcessRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  listForSession(
    sessionId: string,
    options: { status?: BackgroundProcessStatus; limit?: number } = {},
  ): StoredBackgroundProcess[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    if (options.status) {
      const rows = this.db.prepare(
        `SELECT * FROM background_processes
          WHERE session_id = ? AND status = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      ).all(sessionId, options.status, limit) as BackgroundProcessRow[];
      return rows.map(fromSqlRow);
    }
    const rows = this.db.prepare(
      `SELECT * FROM background_processes
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(sessionId, limit) as BackgroundProcessRow[];
    return rows.map(fromSqlRow);
  }

  transitionToRunning(
    id: string,
    expectedVersion: number,
    startedAt: number,
  ): StoredBackgroundProcess | undefined {
    const row = this.db.prepare(
      `UPDATE background_processes
          SET status = 'running',
              started_at = COALESCE(started_at, ?),
              version = version + 1
        WHERE id = ? AND version = ? AND status = 'queued'
        RETURNING *`,
    ).get(startedAt, id, expectedVersion) as BackgroundProcessRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  finish(
    id: string,
    expectedVersion: number,
    terminal: BackgroundProcessTerminal,
  ): StoredBackgroundProcess | undefined {
    const row = this.db.prepare(
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
    return row ? fromSqlRow(row) : undefined;
  }

  recoverInterrupted(at: number): StoredBackgroundProcess[] {
    const rows = this.db.prepare(
      `UPDATE background_processes
          SET status = 'interrupted',
              completed_at = ?,
              termination_reason = 'Application stopped before the process completed',
              version = version + 1
        WHERE status IN ('queued','running')
        RETURNING *`,
    ).all(at) as BackgroundProcessRow[];
    return rows.map(fromSqlRow);
  }

}

function fromSqlRow(row: BackgroundProcessRow): StoredBackgroundProcess {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.origin_turn_id ? { originTurnId: row.origin_turn_id } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    command: row.command,
    ...(row.description ? { description: row.description } : {}),
    cwd: row.cwd,
    status: row.status,
    timeoutMs: row.timeout_ms,
    version: row.version,
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.termination_reason
      ? { terminationReason: row.termination_reason }
      : {}),
    stdoutBytes: row.stdout_bytes,
    stderrBytes: row.stderr_bytes,
    outputTruncated: row.output_truncated === 1,
    outputRelativePath: row.output_relative_path,
  };
}
