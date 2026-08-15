// 持久化 Tool 副作用边界；完整输入与结果只存在于 Message。
import type { SqliteDb } from '../../database/database.js';

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
  call_id: string;
  session_id: string;
  turn_id: string;
  agent_run_id: string | null;
  tool_name: string;
  status: PersistedToolExecutionStatus;
  started_at: number | null;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

/** 提供给 Tool 执行状态端口的领域形状，不泄露 SQL 列名和 null。 */
interface StoredToolExecution {
  callId: string;
  sessionId: string;
  turnId: string;
  agentRunId?: string;
  toolName: string;
  status: PersistedToolExecutionStatus;
  startedAt?: number;
  completedAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface ToolExecutionInsert {
  callId: string;
  sessionId: string;
  turnId: string;
  agentRunId?: string;
  toolName: string;
  createdAt: number;
}

interface ToolExecutionTerminalUpdate {
  completedAt: number;
}

/**
 * 工具执行状态的原子数据库操作；合法转换与恢复语义由 Tools 管理。
 * 记录随 Session/Turn 外键级联删除。
 */
export class ToolExecutionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insertPrepared(value: ToolExecutionInsert): StoredToolExecution | undefined {
    const row = this.db.prepare(
      `INSERT OR IGNORE INTO tool_executions (
         call_id, session_id, turn_id, agent_run_id, tool_name,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
       RETURNING *`,
    ).get(
      value.callId,
      value.sessionId,
      value.turnId,
      value.agentRunId ?? null,
      value.toolName,
      value.createdAt,
      value.createdAt,
    ) as ToolExecutionSqlRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  findByCallId(callId: string): StoredToolExecution | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tool_executions WHERE call_id = ?',
    ).get(callId) as ToolExecutionSqlRow | undefined;
    return row ? fromSqlRow(row) : undefined;
  }

  listForTurn(turnId: string): StoredToolExecution[] {
    const rows = this.db.prepare(
      `SELECT * FROM tool_executions
        WHERE turn_id = ?
        ORDER BY created_at ASC, call_id ASC`,
    ).all(turnId) as ToolExecutionSqlRow[];
    return rows.map(fromSqlRow);
  }

  transition(
    callId: string,
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

  /** 启动恢复先读取非终态调用，再由恢复器写 Message 并推进终态。 */
  listInterrupted(): StoredToolExecution[] {
    const rows = this.db.prepare(
      `SELECT * FROM tool_executions
        WHERE status IN ('prepared', 'authorized', 'running')
        ORDER BY created_at ASC, call_id ASC`,
    ).all() as ToolExecutionSqlRow[];
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
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}
