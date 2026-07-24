// 持久化工具执行状态，并同时保留父 Turn 与可选 AgentRun 的审计身份。
import type { AgentRunId, SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { SqliteDb } from '../database.js';

type PersistedToolExecutionStatus =
  | 'prepared'
  | 'authorized'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

/** SQLite 行结构，只在 Storage 内部存在。 */
interface ToolExecutionSqlRow {
  call_id: ToolCallId;
  session_id: SessionId;
  turn_id: TurnId;
  agent_run_id: AgentRunId | null;
  tool_name: string;
  input_json: string;
  input_digest: string;
  status: PersistedToolExecutionStatus;
  result_preview: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

/** 提供给 Tool Journal Store 端口的领域形状，不泄露 SQL 列名和 null。 */
interface StoredToolExecution {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  agentRunId?: AgentRunId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  status: PersistedToolExecutionStatus;
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface ToolExecutionInsert {
  callId: ToolCallId;
  sessionId: SessionId;
  turnId: TurnId;
  agentRunId?: AgentRunId;
  toolName: string;
  inputJson: string;
  inputDigest: string;
  createdAt: number;
}

interface ToolExecutionTerminalUpdate {
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAt: number;
}

/**
 * 工具执行日志的原子数据库操作；合法状态转换与恢复语义由 Tools 管理。
 * 记录随 Session/Turn 外键级联删除，不建立另一套独立日志保留周期。
 */
export class ToolExecutionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insertPrepared(value: ToolExecutionInsert): StoredToolExecution | undefined {
    const row = this.db.prepare(
      `INSERT OR IGNORE INTO tool_executions (
         call_id, session_id, turn_id, agent_run_id, tool_name, input_json, input_digest,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
       RETURNING *`,
    ).get(
      value.callId,
      value.sessionId,
      value.turnId,
      value.agentRunId ?? null,
      value.toolName,
      value.inputJson,
      value.inputDigest,
      value.createdAt,
      value.createdAt,
    ) as ToolExecutionSqlRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  findByCallId(callId: ToolCallId): StoredToolExecution | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tool_executions WHERE call_id = ?',
    ).get(callId) as ToolExecutionSqlRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  listForTurn(turnId: TurnId): StoredToolExecution[] {
    const rows = this.db.prepare(
      `SELECT * FROM tool_executions
        WHERE turn_id = ?
        ORDER BY created_at ASC, call_id ASC`,
    ).all(turnId) as ToolExecutionSqlRow[];
    return rows.map(fromSqlRow);
  }

  transition(
    callId: ToolCallId,
    expectedVersion: number,
    from: readonly PersistedToolExecutionStatus[],
    to: PersistedToolExecutionStatus,
    at: number,
    terminal?: ToolExecutionTerminalUpdate,
  ): StoredToolExecution | undefined {
    if (from.length === 0) return undefined;
    const placeholders = from.map(() => '?').join(', ');
    const row = this.db.prepare(
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
    ) as ToolExecutionSqlRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  /**
   * 启动恢复：尚未执行的调用可以安全取消；已经 running 的调用副作用未知，
   * 必须标记 outcome_unknown，绝不能自动重放。
   */
  recoverInterrupted(at: number): StoredToolExecution[] {
    const rows = this.db.prepare(
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
    ).all(at, at) as ToolExecutionSqlRow[];
    return rows.map(fromSqlRow);
  }
}

function fromSqlRow(row: ToolExecutionSqlRow): StoredToolExecution {
  return {
    callId: row.call_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ...(row.agent_run_id !== null ? { agentRunId: row.agent_run_id } : {}),
    toolName: row.tool_name,
    inputJson: row.input_json,
    inputDigest: row.input_digest,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result_preview !== null ? { resultPreview: row.result_preview } : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}
