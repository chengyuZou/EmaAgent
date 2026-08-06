// 在一个 SQLite 只读快照内按稳定顺序流出完整 Session 记录，供 Backup 逐行落盘。
import type { SqliteDb } from '../../database/database.js';
import type { AgentRunMessageRow } from './agent-run-messages.js';
import type { AgentRunRow } from './agent-runs.js';
import type { AttachmentRow } from './attachment.js';
import type { BackgroundProcessRow } from './backgroundProcesses.js';
import type { KbActivationRow } from './kb-activations.js';
import type { MessageRow } from './messages.js';
import type { SessionNoteRow } from './session-notes.js';
import type { SessionRow } from './sessions.js';
import type { AudioEntryRow, MemoryStateRow } from './storage-stats.js';
import type { TaskDependencyRow, TaskRow } from './tasks.js';
import type { TurnRow } from './turns.js';
import type { UsageRecordRow } from './usage-records.js';

export interface SessionBackupToolExecutionRow {
  call_id: string;
  session_id: string;
  turn_id: string;
  agent_run_id: string | null;
  tool_name: string;
  status: 'prepared' | 'authorized' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  started_at: number | null;
  completed_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

/**
 * 所有 Iterable 只在 withSnapshot 回调期间有效；调用方必须在回调返回前消费，
 * 不能把游标带出事务后继续读取。
 */
export interface SessionBackupSnapshot {
  readonly session: SessionRow;
  readonly turns: Iterable<TurnRow>;
  readonly messages: Iterable<MessageRow>;
  readonly tasks: Iterable<TaskRow>;
  readonly taskDependencies: Iterable<TaskDependencyRow>;
  readonly agentRuns: Iterable<AgentRunRow>;
  readonly agentRunMessages: Iterable<AgentRunMessageRow>;
  readonly toolExecutions: Iterable<SessionBackupToolExecutionRow>;
  readonly backgroundProcesses: Iterable<BackgroundProcessRow>;
  readonly attachments: Iterable<AttachmentRow>;
  readonly audio: Iterable<AudioEntryRow>;
  readonly usageRecords: Iterable<UsageRecordRow>;
  readonly kbActivations: Iterable<KbActivationRow>;
  readonly memoryState: MemoryStateRow | null;
  readonly sessionNotes: SessionNoteRow | null;
}

export class SessionBackupReader {
  constructor(private readonly db: SqliteDb) {}

  withSnapshot<T>(
    sessionId: string,
    consume: (snapshot: SessionBackupSnapshot) => T,
  ): T | null {
    return this.db.transaction(() => {
      const session = this.db.prepare(
        'SELECT * FROM sessions WHERE id = ?',
      ).get(sessionId) as SessionRow | undefined;
      if (!session) return null;

      return consume({
        session,
        turns: this.iterate<TurnRow>(
          `SELECT * FROM turns
           WHERE session_id = ?
           ORDER BY started_at ASC, id ASC`,
          sessionId,
        ),
        messages: this.iterate<MessageRow>(
          `SELECT * FROM messages
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        tasks: this.iterate<TaskRow>(
          `SELECT * FROM tasks
           WHERE session_id = ?
           ORDER BY display_number ASC, id ASC`,
          sessionId,
        ),
        taskDependencies: this.iterate<TaskDependencyRow>(
          `SELECT * FROM task_dependencies
           WHERE session_id = ?
           ORDER BY blocker_task_id ASC, blocked_task_id ASC`,
          sessionId,
        ),
        agentRuns: this.iterate<AgentRunRow>(
          `SELECT * FROM agent_runs
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        agentRunMessages: this.iterate<AgentRunMessageRow>(
          `SELECT m.*
           FROM agent_run_messages m
           JOIN agent_runs r ON r.id = m.agent_run_id
           WHERE r.session_id = ?
           ORDER BY r.created_at ASC, r.id ASC, m.sequence ASC, m.id ASC`,
          sessionId,
        ),
        toolExecutions: this.iterate<SessionBackupToolExecutionRow>(
          `SELECT * FROM tool_executions
           WHERE session_id = ?
           ORDER BY created_at ASC, call_id ASC`,
          sessionId,
        ),
        backgroundProcesses: this.iterate<BackgroundProcessRow>(
          `SELECT * FROM background_processes
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        attachments: this.iterate<AttachmentRow>(
          `SELECT * FROM turn_attachments
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        audio: this.iterate<AudioEntryRow>(
          `SELECT turn_id, mime_type, byte_size, duration_ms,
                  segment_count, created_at, storage_path
           FROM turn_audio_merged
           WHERE session_id = ?
           ORDER BY created_at ASC, turn_id ASC`,
          sessionId,
        ),
        usageRecords: this.iterate<UsageRecordRow>(
          `SELECT * FROM usage_records
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        kbActivations: this.iterate<KbActivationRow>(
          `SELECT * FROM kb_activations
           WHERE session_id = ?
           ORDER BY created_at ASC, id ASC`,
          sessionId,
        ),
        memoryState: (
          this.db.prepare(
            `SELECT session_id, surfaced_json, overrides_json
             FROM memory_session_state WHERE session_id = ?`,
          ).get(sessionId) as MemoryStateRow | undefined
        ) ?? null,
        sessionNotes: (
          this.db.prepare(
            `SELECT session_id, body, tokens_at_last_update, updated_at
             FROM session_notes WHERE session_id = ?`,
          ).get(sessionId) as SessionNoteRow | undefined
        ) ?? null,
      });
    })();
  }

  private iterate<T>(sql: string, sessionId: string): Iterable<T> {
    return {
      [Symbol.iterator]: () => (
        this.db.prepare(sql).iterate(sessionId) as IterableIterator<T>
      ),
    };
  }
}
