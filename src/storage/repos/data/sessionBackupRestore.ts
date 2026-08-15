// 在单个 SQLite 事务中逐条恢复 Session 备份，并让数据库约束承担最终引用校验。
import type { SqliteDb } from '../../database/database.js';
import type { AgentRunRow } from './agent-runs.js';
import type { AgentRunMessageRow } from './agent-run-messages.js';
import type { AttachmentRestoreRow, AudioRestoreRow, MessageRestoreRow, NotesRestoreData, TurnRestoreRow } from './storage-stats.js';
import type { BackgroundProcessRow } from './backgroundProcesses.js';
import type { KbActivationRow } from './kb-activations.js';
import type { MemoryStateRow } from './storage-stats.js';
import type { TaskDependencyRow, TaskRow } from './tasks.js';
import type { UsageRecordRow } from './usage-records.js';
import type { SessionBackupToolExecutionRow } from './sessionBackup.js';

export interface SessionBackupRestoreInput {
  readonly session: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    lastActivityAt: number;
    archivedAt: number | null;
    pinned: boolean;
    forkedFromSessionId: string | null;
    executionProfile: 'chat' | 'work';
    narrativePolicy: 'auto' | 'always' | 'off';
    providerConfigId: string | null;
    modelId: string | null;
  };
  readonly turns: Iterable<TurnRestoreRow>;
  readonly messages: Iterable<MessageRestoreRow>;
  readonly tasks: Iterable<Omit<TaskRow, 'active_agent_run_id'>>;
  readonly taskDependencies: Iterable<TaskDependencyRow>;
  readonly agentRuns: Iterable<AgentRunRow>;
  readonly agentRunMessages: Iterable<AgentRunMessageRow>;
  readonly toolExecutions: Iterable<SessionBackupToolExecutionRow>;
  readonly backgroundProcesses: Iterable<BackgroundProcessRow>;
  readonly attachments: Iterable<AttachmentRestoreRow>;
  readonly audio: Iterable<AudioRestoreRow>;
  readonly usageRecords: Iterable<UsageRecordRow>;
  readonly kbActivations: Iterable<KbActivationRow>;
  readonly memoryState: MemoryStateRow | null;
  readonly notes: NotesRestoreData | null;
}

export class SessionBackupRestoreError extends Error {
  readonly code = 'storage/session-backup-restore-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'SessionBackupRestoreError';
  }
}

export class SessionBackupRestorer {
  constructor(private readonly db: SqliteDb) {}

  restore(input: SessionBackupRestoreInput): void {
    validateSession(input);
    this.db.transaction(() => this.restoreInTransaction(input))();
  }

  private restoreInTransaction(input: SessionBackupRestoreInput): void {
    const session = input.session;
    const forkedFromSessionId = session.forkedFromSessionId
      && this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').pluck().get(session.forkedFromSessionId)
      ? session.forkedFromSessionId
      : null;
    this.db.prepare(`
      INSERT INTO sessions (
        id, title, workspace_root, created_at, updated_at, last_activity_at,
        archived_at, pinned, forked_from_session_id,
        execution_profile, narrative_policy, provider_config_id, model_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.title, session.createdAt, session.updatedAt, session.lastActivityAt,
      session.archivedAt, session.pinned ? 1 : 0,
      forkedFromSessionId, session.executionProfile, session.narrativePolicy,
      session.providerConfigId, session.modelId,
    );

    const turn = this.db.prepare(`
      INSERT INTO turns (
        id, session_id, trigger_type, execution_profile, narrative_policy,
        provider_config_id, model_id, status,
        created_at, completed_at, error_code, error_message,
        iterations, usage_input_tokens, usage_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.turns) {
      turn.run(
        row.id, session.id, row.triggerType,
        row.executionProfile, row.narrativePolicy,
        row.providerConfigId ?? null, row.modelId ?? null,
        row.status, row.createdAt, row.completedAt, row.errorCode,
        row.errorMessage, row.iterations, row.usageInputTokens, row.usageOutputTokens,
      );
    }

    const message = this.db.prepare(`
      INSERT INTO messages (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.messages) {
      message.run(
        row.id, session.id, row.turnId, row.role, row.kind, row.blocksJson,
        row.interrupted ? 1 : 0, row.createdAt,
      );
    }

    const task = this.db.prepare(`
      INSERT INTO tasks (
        id, session_id, display_number, subject, description, active_form, status,
        created_by_turn_id, completed_by_turn_id, version, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.tasks) {
      task.run(
        row.id, session.id, row.display_number, row.subject, row.description, row.active_form,
        row.status, row.created_by_turn_id, row.completed_by_turn_id, row.version,
        row.created_at, row.updated_at, row.completed_at,
      );
    }
    const dependency = this.db.prepare(`
      INSERT INTO task_dependencies (session_id, blocker_task_id, blocked_task_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of input.taskDependencies) {
      dependency.run(session.id, row.blocker_task_id, row.blocked_task_id, row.created_at);
    }

    const agentRun = this.db.prepare(`
      INSERT INTO agent_runs (
        id, session_id, parent_turn_id, parent_agent_run_id, task_id, kind, purpose,
        provider_config_id, model_id, status, error, iterations, tool_call_count,
        input_tokens, output_tokens, output_excerpt, version, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of orderAgentRuns(input.agentRuns)) {
      agentRun.run(
        row.id, session.id, row.parent_turn_id, row.parent_agent_run_id, row.task_id,
        row.kind, row.purpose, row.provider_config_id, row.model_id, row.status, row.error,
        row.iterations, row.tool_call_count, row.input_tokens, row.output_tokens,
        row.output_excerpt, row.version, row.created_at, row.updated_at, row.completed_at,
      );
    }

    const runMessage = this.db.prepare(`
      INSERT INTO agent_run_messages (id, agent_run_id, role, content_json, sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.agentRunMessages) {
      runMessage.run(row.id, row.agent_run_id, row.role, row.content_json, row.sequence, row.created_at);
    }

    const tool = this.db.prepare(`
      INSERT INTO tool_executions (
        call_id, session_id, turn_id, agent_run_id, tool_name,
        status, started_at, completed_at,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.toolExecutions) {
      tool.run(
        row.call_id, session.id, row.turn_id, row.agent_run_id, row.tool_name,
        row.status, row.started_at, row.completed_at, row.version,
        row.created_at, row.updated_at,
      );
    }

    const process = this.db.prepare(`
      INSERT INTO background_processes (
        id, session_id, origin_turn_id, tool_call_id, command, description, cwd,
        status, timeout_ms, version, created_at, started_at, completed_at, exit_code,
        termination_reason, stdout_bytes, stderr_bytes, output_truncated,
        output_relative_path, completion_claimed_at, continuation_turn_id, model_notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.backgroundProcesses) {
      process.run(
        row.id, session.id, row.origin_turn_id, row.tool_call_id, row.command,
        row.description, row.cwd, row.status, row.timeout_ms, row.version, row.created_at,
        row.started_at, row.completed_at, row.exit_code, row.termination_reason,
        row.stdout_bytes, row.stderr_bytes, row.output_truncated, row.output_relative_path,
        row.completion_claimed_at, row.continuation_turn_id, row.model_notified_at,
      );
    }

    const attachment = this.db.prepare(`
      INSERT INTO attachments (
        id, turn_id, session_id, kind, name, mime, source_path, byte_size, source_modified_at,
        image_path, image_byte_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.attachments) {
      attachment.run(
        row.id, row.turnId, session.id, row.kind, row.name, row.mime,
        row.sourcePath, row.byteSize, row.sourceModifiedAt,
        row.imagePath, row.imageByteSize, row.createdAt,
      );
    }
    const audio = this.db.prepare(`
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, segment_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.audio) {
      audio.run(
        row.turnId, session.id, row.storagePath, row.mimeType, row.byteSize,
        row.durationMs, row.segmentCount, row.createdAt,
      );
    }

    const usage = this.db.prepare(`
      INSERT INTO usage_records (
        id, session_id, turn_id, provider_id, model_id, capability, status,
        input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
        quantity, unit, duration_ms, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.usageRecords) {
      usage.run(
        row.id, session.id, row.turn_id, row.provider_id, row.model_id, row.capability,
        row.status, row.input_tokens, row.output_tokens, row.cache_read_input_tokens,
        row.cache_write_input_tokens, row.quantity, row.unit,
        row.duration_ms, row.error_code, row.created_at,
      );
    }
    const kb = this.db.prepare(`
      INSERT INTO kb_activations (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.kbActivations) {
      kb.run(row.id, row.call_id, row.kb_id, row.asset_id, session.id, row.turn_id, row.created_at);
    }
    if (input.memoryState) {
      this.db.prepare(`
        INSERT INTO memory_session_state (session_id, surfaced_json, overrides_json)
        VALUES (?, ?, ?)
      `).run(session.id, input.memoryState.surfaced_json, input.memoryState.overrides_json);
    }
    if (input.notes) {
      this.db.prepare(`
        INSERT INTO session_notes (session_id, body, tokens_at_last_update, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(session.id, input.notes.body, input.notes.tokensAtLastUpdate, input.notes.updatedAt);
    }

    const foreignKeyError = (this.db.pragma('foreign_key_check') as unknown[])[0];
    if (foreignKeyError) {
      throw new SessionBackupRestoreError(`恢复后外键检查失败: ${JSON.stringify(foreignKeyError)}`);
    }
  }
}

function validateSession(input: SessionBackupRestoreInput): void {
  const session = input.session;
  if (!session.id) throw new SessionBackupRestoreError('Session id 不能为空');
  if (session.forkedFromSessionId === session.id) {
    throw new SessionBackupRestoreError('Session 不能把自身设为 forkedFromSessionId');
  }
  if ((session.providerConfigId === null) !== (session.modelId === null)) {
    throw new SessionBackupRestoreError('模型选择必须同时包含供应商配置和模型');
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
