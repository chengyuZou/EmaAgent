// 在同一 SQLite 读取事务中提供 Session 全量行，并在单一写事务中恢复它们。
import type { SqliteDb } from '../../database/database.js';
import type { AgentRunMessageRow } from './agent-run-messages.js';
import type { AgentRunRow } from './agent-runs.js';
import type { AttachmentRow } from './attachments.js';
import type { BackgroundProcessRow } from './backgroundProcesses.js';
import type { MessageRow } from './messages.js';
import type { SessionRow } from './sessions.js';
import type { SpeechOutputRow, SpeechSegmentRow } from './speechOutputs.js';
import type { TaskRow } from './tasks.js';
import type { TurnRow } from './turns.js';
import type { UsageRecordRow } from './usage-records.js';

export interface SessionBackupToolExecutionRow {
  call_id: string;
  session_id: string;
  turn_id: string;
  agent_run_id: string | null;
  tool_name: string;
  status:
    | 'prepared'
    | 'authorized'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  started_at: number | null;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export type SessionBackupTaskRow = TaskRow;

/** Iterable 只允许在 readSession 回调期间消费，不能把 SQLite 游标带出事务。 */
export interface SessionBackupRows {
  readonly session: SessionRow;
  readonly turns: Iterable<TurnRow>;
  readonly messages: Iterable<MessageRow>;
  readonly tasks: Iterable<SessionBackupTaskRow>;
  readonly agentRuns: Iterable<AgentRunRow>;
  readonly agentRunMessages: Iterable<AgentRunMessageRow>;
  readonly toolExecutions: Iterable<SessionBackupToolExecutionRow>;
  readonly backgroundProcesses: Iterable<BackgroundProcessRow>;
  readonly attachments: Iterable<AttachmentRow>;
  readonly speechOutputs: Iterable<SpeechOutputRow>;
  readonly speechSegments: Iterable<SpeechSegmentRow>;
  readonly usageRecords: Iterable<UsageRecordRow>;
}

/** Backup 已完成文件落位和状态收口后交给 Storage 的数据库行。 */
export interface SessionBackupRestoreRows extends SessionBackupRows {}

export class SessionBackupRestoreError extends Error {
  readonly code = 'storage/session-backup-restore-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'SessionBackupRestoreError';
  }
}

export class SessionBackupReader {
  constructor(private readonly db: SqliteDb) {}

  hasSession(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId));
  }

  readSession<T>(sessionId: string, consume: (rows: SessionBackupRows) => T): T | null {
    return this.db.transaction(() => {
      const session = this.db.prepare(
        'SELECT * FROM sessions WHERE id = ?',
      ).get(sessionId) as SessionRow | undefined;
      if (!session) return null;

      return consume({
        session,
        turns: this.iterate<TurnRow>(
          'SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, id ASC',
          sessionId,
        ),
        messages: this.iterate<MessageRow>(
          'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
          sessionId,
        ),
        tasks: this.iterate<SessionBackupTaskRow>(`
          SELECT id, session_id, display_number, subject, description, active_form,
                 status, created_by_turn_id, completed_by_turn_id, version,
                 created_at, updated_at, completed_at
          FROM tasks
          WHERE session_id = ?
          ORDER BY display_number ASC, id ASC
        `, sessionId),
        agentRuns: this.iterate<AgentRunRow>(
          'SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC, id ASC',
          sessionId,
        ),
        agentRunMessages: this.iterate<AgentRunMessageRow>(`
          SELECT message.*
          FROM agent_run_messages message
          JOIN agent_runs run ON run.id = message.agent_run_id
          WHERE run.session_id = ?
          ORDER BY run.created_at ASC, run.id ASC, message.sequence ASC, message.id ASC
        `, sessionId),
        toolExecutions: this.iterate<SessionBackupToolExecutionRow>(
          'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY created_at ASC, call_id ASC',
          sessionId,
        ),
        backgroundProcesses: this.iterate<BackgroundProcessRow>(`
          SELECT * FROM background_processes
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
        `, sessionId),
        attachments: this.iterate<AttachmentRow>(
          'SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC, id ASC',
          sessionId,
        ),
        speechOutputs: this.iterate<SpeechOutputRow>(`
          SELECT * FROM speech_outputs
          WHERE session_id = ?
          ORDER BY created_at ASC, turn_id ASC
        `, sessionId),
        speechSegments: this.iterate<SpeechSegmentRow>(`
          SELECT * FROM speech_segments
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
        `, sessionId),
        usageRecords: this.iterate<UsageRecordRow>(`
          SELECT * FROM usage_records
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
        `, sessionId),
      });
    })();
  }

  private iterate<T>(sql: string, sessionId: string): Iterable<T> {
    return {
      [Symbol.iterator]: () => this.db.prepare(sql).iterate(sessionId) as IterableIterator<T>,
    };
  }
}

export class SessionBackupRestorer {
  constructor(private readonly db: SqliteDb) {}

  restoreSession(rows: SessionBackupRestoreRows): void {
    if (!rows.session.id) throw new SessionBackupRestoreError('Session id 不能为空');
    if (rows.session.forked_from_session_id === rows.session.id) {
      throw new SessionBackupRestoreError('Session 不能把自身设为 fork 来源');
    }
    if ((rows.session.provider_id === null) !== (rows.session.model_id === null)) {
      throw new SessionBackupRestoreError('Session 模型选择必须同时包含 Provider 和 Model');
    }
    this.db.transaction(() => this.restoreInTransaction(rows))();
  }

  private restoreInTransaction(rows: SessionBackupRestoreRows): void {
    const session = rows.session;
    const projectId = session.project_id !== null && this.exists('projects', session.project_id)
      ? session.project_id
      : null;
    const forkedFromSessionId = session.forked_from_session_id !== null
      && this.exists('sessions', session.forked_from_session_id)
      ? session.forked_from_session_id
      : null;
    const forkedFromTurnId = forkedFromSessionId !== null
      && session.forked_from_turn_id !== null
      && this.db.prepare('SELECT 1 FROM turns WHERE id = ? AND session_id = ?')
        .get(session.forked_from_turn_id, forkedFromSessionId)
      ? session.forked_from_turn_id
      : null;

    this.db.prepare(`
      INSERT INTO sessions (
        id, title, workspace_root, project_id, pinned, archived_at,
        forked_from_session_id, forked_from_turn_id,
        last_viewed_at, last_activity_at, created_at, updated_at,
        provider_id, model_id, execution_profile, narrative_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.title, session.workspace_root, projectId, session.pinned,
      session.archived_at, forkedFromSessionId, forkedFromTurnId,
      session.last_viewed_at, session.last_activity_at, session.created_at, session.updated_at,
      session.provider_id, session.model_id, session.execution_profile, session.narrative_policy,
    );

    const insertTurn = this.db.prepare(`
      INSERT INTO turns (
        id, session_id, status, trigger_type, execution_profile, narrative_policy,
        provider_id, model_id, character_directory_name,
        iterations, usage_input_tokens, usage_output_tokens,
        created_at, completed_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.turns) {
      insertTurn.run(
        row.id, session.id, row.status, row.trigger_type,
        row.execution_profile, row.narrative_policy, row.provider_id, row.model_id,
        row.character_directory_name, row.iterations, row.usage_input_tokens,
        row.usage_output_tokens, row.created_at, row.completed_at,
        row.error_code, row.error_message,
      );
    }

    const insertMessage = this.db.prepare(`
      INSERT INTO messages (
        id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at,
        summarized_through_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.messages) {
      insertMessage.run(
        row.id, session.id, row.turn_id, row.role, row.kind,
        row.blocks_json, row.interrupted, row.created_at,
        row.summarized_through_message_id,
      );
    }

    const insertTask = this.db.prepare(`
      INSERT INTO tasks (
        id, session_id, display_number, subject, description, active_form, status,
        created_by_turn_id, completed_by_turn_id, version,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.tasks) {
      insertTask.run(
        row.id, session.id, row.display_number, row.subject, row.description,
        row.active_form, row.status, row.created_by_turn_id,
        row.completed_by_turn_id, row.version, row.created_at, row.updated_at, row.completed_at,
      );
    }

    const insertAgentRun = this.db.prepare(`
      INSERT INTO agent_runs (
        id, session_id, parent_turn_id, parent_agent_run_id,
        context_mode, description, provider_id, model_id, status, error,
        iterations, tool_call_count, input_tokens, output_tokens, output_excerpt,
        version, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of orderAgentRuns(rows.agentRuns)) {
      insertAgentRun.run(
        row.id, session.id, row.parent_turn_id, row.parent_agent_run_id,
        row.context_mode, row.description, row.provider_id, row.model_id,
        row.status, row.error, row.iterations, row.tool_call_count,
        row.input_tokens, row.output_tokens, row.output_excerpt,
        row.version, row.created_at, row.updated_at, row.completed_at,
      );
    }

    const insertAgentRunMessage = this.db.prepare(`
      INSERT INTO agent_run_messages (
        id, agent_run_id, role, content_json, sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.agentRunMessages) {
      insertAgentRunMessage.run(
        row.id, row.agent_run_id, row.role, row.content_json, row.sequence, row.created_at,
      );
    }

    const insertToolExecution = this.db.prepare(`
      INSERT INTO tool_executions (
        call_id, session_id, turn_id, agent_run_id, tool_name,
        status, started_at, completed_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.toolExecutions) {
      insertToolExecution.run(
        row.call_id, session.id, row.turn_id, row.agent_run_id, row.tool_name,
        row.status, row.started_at, row.completed_at,
        row.version, row.created_at, row.updated_at,
      );
    }

    const insertBackgroundProcess = this.db.prepare(`
      INSERT INTO background_processes (
        id, session_id, origin_turn_id, tool_call_id, command, description, cwd,
        status, timeout_ms, version, created_at, started_at, completed_at, exit_code,
        termination_reason, stdout_bytes, stderr_bytes, output_truncated,
        output_relative_path, completion_claimed_at, continuation_turn_id, model_notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.backgroundProcesses) {
      insertBackgroundProcess.run(
        row.id, session.id, row.origin_turn_id, row.tool_call_id,
        row.command, row.description, row.cwd, row.status, row.timeout_ms,
        row.version, row.created_at, row.started_at, row.completed_at,
        row.exit_code, row.termination_reason, row.stdout_bytes, row.stderr_bytes,
        row.output_truncated, row.output_relative_path, row.completion_claimed_at,
        row.continuation_turn_id, row.model_notified_at,
      );
    }

    const insertAttachment = this.db.prepare(`
      INSERT INTO attachments (
        id, turn_id, session_id, kind, name, mime,
        source_path, byte_size, source_modified_at,
        image_path, image_byte_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.attachments) {
      insertAttachment.run(
        row.id, row.turn_id, session.id, row.kind, row.name, row.mime,
        row.source_path, row.byte_size, row.source_modified_at,
        row.image_path, row.image_byte_size, row.created_at,
      );
    }

    const insertSpeechOutput = this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type,
        byte_size, duration_ms, segment_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.speechOutputs) {
      insertSpeechOutput.run(
        row.turn_id, session.id, row.storage_path, row.mime_type,
        row.byte_size, row.duration_ms, row.segment_count, row.created_at,
      );
    }

    const insertSpeechSegment = this.db.prepare(`
      INSERT INTO speech_segments (
        id, turn_id, session_id, sentence_index, storage_path,
        mime_type, byte_size, duration_ms, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.speechSegments) {
      insertSpeechSegment.run(
        row.id, row.turn_id, session.id, row.sentence_index, row.storage_path,
        row.mime_type, row.byte_size, row.duration_ms, row.text, row.created_at,
      );
    }

    const insertUsage = this.db.prepare(`
      INSERT INTO usage_records (
        id, session_id, turn_id, provider_id, model_id, capability, status,
        input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
        quantity, unit, duration_ms, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows.usageRecords) {
      insertUsage.run(
        row.id, session.id, row.turn_id, row.provider_id, row.model_id,
        row.capability, row.status, row.input_tokens, row.output_tokens,
        row.cache_read_input_tokens, row.cache_write_input_tokens,
        row.quantity, row.unit, row.duration_ms, row.error_code, row.created_at,
      );
    }

    const foreignKeyError = (this.db.pragma('foreign_key_check') as unknown[])[0];
    if (foreignKeyError) {
      throw new SessionBackupRestoreError(
        `恢复后外键检查失败: ${JSON.stringify(foreignKeyError)}`,
      );
    }
  }

  private exists(table: 'projects' | 'sessions', id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
  }
}

function orderAgentRuns(rows: Iterable<AgentRunRow>): AgentRunRow[] {
  const pending = new Map<string, AgentRunRow>();
  for (const row of rows) {
    if (pending.has(row.id)) throw new SessionBackupRestoreError(`AgentRun id 重复: ${row.id}`);
    pending.set(row.id, row);
  }

  const ordered: AgentRunRow[] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, row] of pending) {
      if (row.parent_agent_run_id === null || !pending.has(row.parent_agent_run_id)) {
        ordered.push(row);
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) throw new SessionBackupRestoreError('AgentRun 父链存在循环');
  }
  return ordered;
}
