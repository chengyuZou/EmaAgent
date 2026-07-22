import type {
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/contracts';
import type { SqliteDb } from '../database.js';

export type ToolExecutionStatus =
  | 'prepared'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

/** SQLite 行结构；只在 storage 包内部使用。 */
export interface ToolExecutionRow {
  call_id: ToolCallId;
  session_id: SessionId;
  turn_id: TurnId;
  tool_name: string;
  input_json: string;
  input_digest: string;
  status: ToolExecutionStatus;
  result_preview: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface ToolExecutionInsert {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  createdAt: number;
}

export interface ToolExecutionTerminalUpdate {
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt: number;
}

/** 工具执行日志的原子数据库操作；业务状态机由 agent-task Facade 管理。 */
export class ToolExecutionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insertPrepared(value: ToolExecutionInsert): ToolExecutionRow | undefined {
    return this.db.prepare(
      `INSERT OR IGNORE INTO tool_executions (
         call_id, session_id, turn_id, tool_name, input_json, input_digest,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
       RETURNING *`,
    ).get(
      value.callId,
      value.sessionId,
      value.turnId,
      value.toolName,
      value.inputJson,
      value.inputDigest,
      value.createdAt,
      value.createdAt,
    ) as ToolExecutionRow | undefined;
  }

  findByCallId(callId: ToolCallId): ToolExecutionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM tool_executions WHERE call_id = ?',
    ).get(callId) as ToolExecutionRow | undefined;
  }

  listForTurn(turnId: TurnId): ToolExecutionRow[] {
    return this.db.prepare(
      `SELECT * FROM tool_executions
        WHERE turn_id = ?
        ORDER BY created_at ASC, call_id ASC`,
    ).all(turnId) as ToolExecutionRow[];
  }

  transition(
    callId: ToolCallId,
    expectedVersion: number,
    from: readonly ToolExecutionStatus[],
    to: ToolExecutionStatus,
    at: number,
    terminal?: ToolExecutionTerminalUpdate,
  ): ToolExecutionRow | undefined {
    if (from.length === 0) return undefined;
    const placeholders = from.map(() => '?').join(', ');
    return this.db.prepare(
      `UPDATE tool_executions
          SET status         = ?,
              result_preview = ?,
              error_code     = ?,
              error_message  = ?,
              started_at     = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
              completed_at   = ?,
              version        = version + 1,
              updated_at     = ?
        WHERE call_id = ?
          AND version = ?
          AND status IN (${placeholders})
        RETURNING *`,
    ).get(
      to,
      terminal?.resultPreview ?? null,
      terminal?.errorCode ?? null,
      terminal?.errorMessage ?? null,
      to,
      at,
      terminal?.completedAt ?? null,
      at,
      callId,
      expectedVersion,
      ...from,
    ) as ToolExecutionRow | undefined;
  }

  /**
   * 启动恢复：尚未执行的调用可以安全取消；已经 running 的调用副作用未知，
   * 必须标记 outcome_unknown，绝不能自动重放。
   */
  recoverInterrupted(at: number): ToolExecutionRow[] {
    return this.db.prepare(
      `UPDATE tool_executions
          SET status = CASE
                WHEN status = 'running' THEN 'outcome_unknown'
                ELSE 'cancelled'
              END,
              error_code = CASE
                WHEN status = 'running' THEN 'tool/outcome_unknown'
                ELSE 'tool/process_interrupted'
              END,
              error_message = 'Process terminated before the tool lifecycle completed',
              completed_at = ?,
              version = version + 1,
              updated_at = ?
        WHERE status IN ('prepared', 'authorized', 'running')
        RETURNING *`,
    ).all(at, at) as ToolExecutionRow[];
  }
}
