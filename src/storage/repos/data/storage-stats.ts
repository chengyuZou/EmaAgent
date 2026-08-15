// 汇总数据目录与 Session 统计，并执行完整 Session 备份恢复事务。
import type { SqliteDb } from '../../database/database.js';
import type { ExecutionProfileRow, NarrativePolicyRow } from './sessions.js';
import type { TurnTriggerTypeRow } from './turns.js';
import type { AgentRunMessageRow } from './agent-run-messages.js';
import type { KbActivationRow }     from './kb-activations.js';
import type { AgentRunRow }         from './agent-runs.js';
import type { UsageRecordRow }      from './usage-records.js';
import type { TaskDependencyRow, TaskRow } from './tasks.js';
import type { AttachmentRowKind } from './attachments.js';

export type {
  AgentRunMessageRow,
  KbActivationRow,
  AgentRunRow,
  UsageRecordRow,
  TaskDependencyRow,
};

// ════════════════════════════════════════════════════════════════════════════
// DataDir 级聚合统计
// ════════════════════════════════════════════════════════════════════════════

export interface DataDirStats {
  sessionCount:    number;
  turnCount:       number;
  messageCount:    number;
  agentRunCount:   number;
  audioCount:      number;
  audioDurationMs: number;
}

export class DataDirStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  getStats(): DataDirStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions)    AS session_count,
        (SELECT COUNT(*) FROM turns)       AS turn_count,
        (SELECT COUNT(*) FROM messages)    AS message_count,
        (SELECT COUNT(*) FROM agent_runs) AS agent_run_count,
        (SELECT COUNT(*)                      FROM speech_outputs) AS audio_count,
        (SELECT COALESCE(SUM(duration_ms), 0) FROM speech_outputs) AS audio_duration_ms
    `).get() as {
      session_count: number; turn_count: number; message_count: number;
      agent_run_count: number;
      audio_count: number; audio_duration_ms: number;
    };
    return {
      sessionCount:    row.session_count,
      turnCount:       row.turn_count,
      messageCount:    row.message_count,
      agentRunCount:   row.agent_run_count,
      audioCount:      row.audio_count,
      audioDurationMs: row.audio_duration_ms,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Session 级统计 + 导出原始行 + 导入事务
// ════════════════════════════════════════════════════════════════════════════

// ── 统计结果 ─────────────────────────────────────────────────────────────────────

export interface SessionStats {
  turnCount:            number;
  messageCount:         number;
  totalInputTokens:     number;
  totalOutputTokens:    number;
  chatTurns:            number;
  workTurns:            number;
  narrativeAlwaysTurns: number;
  audioTurnCount:       number;
  audioTotalBytes:      number;
  audioTotalDurationMs: number;
  attachmentCount:      number;
  attachmentTotalBytes: number;
}

// ── 导出原始行类型(snake_case--直接对应 DB 列名)────────────────────────────────

export interface AudioEntryRow {
  turn_id:       string;
  mime_type:     string;
  byte_size:     number;
  duration_ms:   number | null;
  segment_count: number;
  created_at:    number;
  storage_path:  string;
}

export interface MemoryStateRow {
  session_id:     string;
  surfaced_json:  string;
  overrides_json: string;
}

// ── 导入(恢复)payload 类型 ───────────────────────────────────────────────────

export interface TurnRestoreRow {
  id: string; sessionId: string;
  triggerType: TurnTriggerTypeRow;
  executionProfile: ExecutionProfileRow;
  narrativePolicy: NarrativePolicyRow;
  providerConfigId: string | null;
  modelId: string | null;
  status: string;
  createdAt: number;
  completedAt: number | null; errorCode: string | null; errorMessage: string | null;
  iterations: number; usageInputTokens: number; usageOutputTokens: number;
}

export interface MessageRestoreRow {
  id: string; sessionId: string; turnId: string | null;
  role: string; kind: string; blocksJson: string;
  interrupted: boolean; createdAt: number;
}

export interface AudioRestoreRow {
  turnId: string; sessionId: string; storagePath: string;
  mimeType: string; byteSize: number; durationMs: number | null;
  segmentCount: number; createdAt: number;
}

export interface AttachmentRestoreRow {
  id: string; turnId: string; kind: AttachmentRowKind; name: string; mime: string;
  byteSize: number; sourceModifiedAt: number;
  sourcePath: string;
  imagePath: string | null; imageByteSize: number | null;
  createdAt: number;
}

export interface NotesRestoreData {
  body: string; tokensAtLastUpdate: number; updatedAt: number;
}

export type TaskRestoreRow = Omit<TaskRow, 'active_agent_run_id'>;

export interface SessionRestorePayload {
  session: {
    id: string; title: string;
    workspaceRoot: string | null; createdAt: number; updatedAt: number;
    lastActivityAt: number; archivedAt: number | null;
    pinned: boolean;
    forkedFromSessionId: string | null; forkedFromTurnId: string | null;
    executionProfile: ExecutionProfileRow;
    narrativePolicy: NarrativePolicyRow;
    /** 旧 ZIP 没有这两个字段，导入时按 null 兼容。 */
    providerConfigId?: string | null;
    modelId?: string | null;
  };
  turns:             TurnRestoreRow[];
  messages:          MessageRestoreRow[];
  audio:             AudioRestoreRow[];
  attachments:       AttachmentRestoreRow[];
  tasks:             TaskRestoreRow[];
  taskDependencies: TaskDependencyRow[];
  agentRuns:         AgentRunRow[];
  agentRunMessages:  AgentRunMessageRestoreRow[];
  memoryState:       MemoryStateRow | null;
  kbActivations:     KbActivationRow[];
  usageRecords:      UsageRecordRow[];
  notes:             NotesRestoreData | null;
}

/** sequence 可选以兼容 data v9 之前导出的 Session 备份。 */
export type AgentRunMessageRestoreRow =
  Omit<AgentRunMessageRow, 'sequence'> & { sequence?: number };

export class SessionRestoreValidationError extends Error {
  readonly code = 'storage/session-restore-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'SessionRestoreValidationError';
  }
}

function validateSessionRestorePayload(payload: SessionRestorePayload): void {
  const sessionId = payload.session.id;
  if (!sessionId) throw new SessionRestoreValidationError('Session id 不能为空');
  if (!['chat', 'work'].includes(payload.session.executionProfile)) {
    throw new SessionRestoreValidationError('Session executionProfile 非法');
  }
  if (!['auto', 'always', 'off'].includes(payload.session.narrativePolicy)) {
    throw new SessionRestoreValidationError('Session narrativePolicy 非法');
  }
  if (payload.session.forkedFromSessionId === sessionId) {
    throw new SessionRestoreValidationError('Session 不能把自身设为 forkedFromSessionId');
  }
  const providerConfigId = payload.session.providerConfigId ?? null;
  const modelId = payload.session.modelId ?? null;
  if ((providerConfigId === null) !== (modelId === null)) {
    throw new SessionRestoreValidationError('Session 模型选择必须同时包含供应商配置和模型');
  }
  if (providerConfigId !== null && (!providerConfigId.trim() || !modelId?.trim())) {
    throw new SessionRestoreValidationError('Session 模型选择不能为空字符串');
  }

  const turnIds = uniqueIds(payload.turns, 'Turn');
  const taskIds = uniqueIds(payload.tasks, 'Task');
  const agentRunIds = uniqueIds(payload.agentRuns, 'AgentRun');
  uniqueIds(payload.messages, 'Message');
  uniqueIds(payload.attachments, 'Attachment');
  uniqueIds(payload.agentRunMessages, 'AgentRunMessage');
  uniqueIds(payload.kbActivations, 'KbActivation');

  for (const turn of payload.turns) {
    assertSessionOwnership('Turn', turn.id, turn.sessionId, sessionId);
    if (turn.triggerType !== 'userMessage') {
      throw new SessionRestoreValidationError(`Turn triggerType 非法: ${turn.id}`);
    }
    if (!['chat', 'work'].includes(turn.executionProfile)) {
      throw new SessionRestoreValidationError(`Turn executionProfile 非法: ${turn.id}`);
    }
    if (!['auto', 'always', 'off'].includes(turn.narrativePolicy)) {
      throw new SessionRestoreValidationError(`Turn narrativePolicy 非法: ${turn.id}`);
    }
  }
  for (const message of payload.messages) {
    assertSessionOwnership('Message', message.id, message.sessionId, sessionId);
    assertOptionalReference('Message.turnId', message.id, message.turnId, turnIds);
  }
  for (const audio of payload.audio) {
    assertSessionOwnership('Audio', audio.turnId, audio.sessionId, sessionId);
    assertReference('Audio.turnId', audio.turnId, audio.turnId, turnIds);
  }
  for (const attachment of payload.attachments) {
    assertReference('Attachment.turnId', attachment.id, attachment.turnId, turnIds);
  }
  for (const task of payload.tasks) {
    assertSessionOwnership('Task', task.id, task.session_id, sessionId);
    assertReference('Task.createdByTurnId', task.id, task.created_by_turn_id, turnIds);
    assertOptionalReference(
      'Task.completedByTurnId',
      task.id,
      task.completed_by_turn_id,
      turnIds,
    );
  }
  for (const dependency of payload.taskDependencies) {
    assertSessionOwnership(
      'TaskDependency',
      `${dependency.blocker_task_id}->${dependency.blocked_task_id}`,
      dependency.session_id,
      sessionId,
    );
    assertReference(
      'TaskDependency.blockerTaskId',
      dependency.blocked_task_id,
      dependency.blocker_task_id,
      taskIds,
    );
    assertReference(
      'TaskDependency.blockedTaskId',
      dependency.blocker_task_id,
      dependency.blocked_task_id,
      taskIds,
    );
  }
  assertTaskDependencyGraph(payload.taskDependencies);
  for (const run of payload.agentRuns) {
    assertSessionOwnership('AgentRun', run.id, run.session_id, sessionId);
    assertReference('AgentRun.parentTurnId', run.id, run.parent_turn_id, turnIds);
    assertOptionalReference(
      'AgentRun.parentAgentRunId',
      run.id,
      run.parent_agent_run_id,
      agentRunIds,
    );
    assertOptionalReference('AgentRun.taskId', run.id, run.task_id, taskIds);
  }
  for (const message of payload.agentRunMessages) {
    assertReference(
      'AgentRunMessage.agentRunId',
      message.id,
      message.agent_run_id,
      agentRunIds,
    );
  }
  if (payload.memoryState) {
    assertSessionOwnership('MemoryState', sessionId, payload.memoryState.session_id, sessionId);
  }
  for (const activation of payload.kbActivations) {
    assertSessionOwnership('KbActivation', activation.id, activation.session_id, sessionId);
    assertOptionalReference('KbActivation.turnId', activation.id, activation.turn_id, turnIds);
  }
  for (const record of payload.usageRecords) {
    assertSessionOwnership('UsageRecord', record.id, record.session_id ?? sessionId, sessionId);
    if (record.turn_id !== null) {
      assertReference('UsageRecord.turnId', record.id, record.turn_id, turnIds);
    }
  }
}

function uniqueIds(rows: ReadonlyArray<{ id: string }>, label: string): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id) throw new SessionRestoreValidationError(`${label} id 不能为空`);
    if (ids.has(row.id)) throw new SessionRestoreValidationError(`${label} id 重复: ${row.id}`);
    ids.add(row.id);
  }
  return ids;
}

function assertSessionOwnership(
  label: string,
  id: string,
  actualSessionId: string,
  expectedSessionId: string,
): void {
  if (actualSessionId !== expectedSessionId) {
    throw new SessionRestoreValidationError(
      `${label} ${id} 属于 Session ${actualSessionId}，预期 ${expectedSessionId}`,
    );
  }
}

function assertReference(
  label: string,
  ownerId: string,
  referencedId: string,
  availableIds: ReadonlySet<string>,
): void {
  if (!availableIds.has(referencedId)) {
    throw new SessionRestoreValidationError(`${label} 引用不存在: ${ownerId} -> ${referencedId}`);
  }
}

function assertOptionalReference(
  label: string,
  ownerId: string,
  referencedId: string | null,
  availableIds: ReadonlySet<string>,
): void {
  if (referencedId !== null) assertReference(label, ownerId, referencedId, availableIds);
}

function assertTaskDependencyGraph(
  dependencies: readonly TaskDependencyRow[],
): void {
  const downstream = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const next = downstream.get(dependency.blocker_task_id) ?? [];
    next.push(dependency.blocked_task_id);
    downstream.set(dependency.blocker_task_id, next);
  }

  const complete = new Set<string>();
  const visit = (taskId: string, path: Set<string>): void => {
    if (complete.has(taskId)) return;
    if (path.has(taskId)) {
      throw new SessionRestoreValidationError(`Task dependency graph 存在循环: ${taskId}`);
    }
    const nextPath = new Set(path);
    nextPath.add(taskId);
    for (const childId of downstream.get(taskId) ?? []) visit(childId, nextPath);
    complete.add(taskId);
  };

  for (const taskId of downstream.keys()) visit(taskId, new Set());
}

// ── Repo ──────────────────────────────────────────────────────────────────────

export class SessionStatsRepo {
  constructor(private readonly db: SqliteDb) {}

  // ── 仪表盘聚合统计 ─────────────────────────────────────────────────────────

  getStats(sessionId: string): SessionStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM turns    WHERE session_id = ?) AS turn_count,
        (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS message_count,
        (SELECT COALESCE(SUM(usage_input_tokens),  0) FROM turns WHERE session_id = ?) AS total_input_tokens,
        (SELECT COALESCE(SUM(usage_output_tokens), 0) FROM turns WHERE session_id = ?) AS total_output_tokens,
        (SELECT COUNT(*) FROM turns
          WHERE session_id = ? AND execution_profile = 'chat') AS chat_turns,
        (SELECT COUNT(*) FROM turns
          WHERE session_id = ? AND narrative_policy = 'always') AS narrative_always_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND execution_profile = 'work') AS work_turns,
        (SELECT COUNT(*)                   FROM speech_outputs  WHERE session_id = ?) AS audio_turn_count,
        (SELECT COALESCE(SUM(byte_size),0) FROM speech_outputs  WHERE session_id = ?) AS audio_total_bytes,
        (SELECT COALESCE(SUM(duration_ms),0) FROM speech_outputs WHERE session_id = ?) AS audio_total_duration_ms,
        (SELECT COUNT(*)              FROM attachments WHERE session_id = ?) AS attachment_count,
        (SELECT COALESCE(SUM(byte_size),0) FROM attachments WHERE session_id = ?) AS attachment_total_bytes
    `).get(
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId,
      sessionId, sessionId,
    ) as {
      turn_count: number; message_count: number;
      total_input_tokens: number; total_output_tokens: number;
      chat_turns: number; work_turns: number; narrative_always_turns: number;
      audio_turn_count: number; audio_total_bytes: number; audio_total_duration_ms: number;
      attachment_count: number; attachment_total_bytes: number;
    };

    return {
      turnCount:            row.turn_count,
      messageCount:         row.message_count,
      totalInputTokens:     row.total_input_tokens,
      totalOutputTokens:    row.total_output_tokens,
      chatTurns:            row.chat_turns,
      workTurns:            row.work_turns,
      narrativeAlwaysTurns: row.narrative_always_turns,
      audioTurnCount:       row.audio_turn_count,
      audioTotalBytes:      row.audio_total_bytes,
      audioTotalDurationMs: row.audio_total_duration_ms,
      attachmentCount:      row.attachment_count,
      attachmentTotalBytes: row.attachment_total_bytes,
    };
  }

  // ── 导出:每表原始行 ────────────────────────────────────────────────────────

  listAudioEntries(sessionId: string): AudioEntryRow[] {
    return this.db.prepare(`
      SELECT turn_id, mime_type, byte_size, duration_ms, segment_count, created_at, storage_path
      FROM speech_outputs
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as AudioEntryRow[];
  }

  /**
   * 记录一个 Turn 的合并音频文件。由 TTS 最终音频投影在归档完成后调用；
   * 不调用时仪表盘统计和导出 ZIP 看不到音频，即使文件仍在磁盘上。
   */
  recordAudioMerged(row: {
    turnId:       string;
    sessionId:    string;
    storagePath:  string;
    mimeType:     string;
    byteSize:     number;
    durationMs:   number | null;
    segmentCount: number;
    createdAt:    number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO speech_outputs
        (turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, segment_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.turnId, row.sessionId, row.storagePath, row.mimeType,
      row.byteSize, row.durationMs, row.segmentCount, row.createdAt,
    );
  }

  listAgentRuns(sessionId: string): AgentRunRow[] {
    return this.db.prepare(`
      SELECT *
      FROM agent_runs WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as AgentRunRow[];
  }

  listAgentRunMessages(sessionId: string): AgentRunMessageRow[] {
    return this.db.prepare(`
      SELECT m.id, m.agent_run_id, m.role, m.content_json, m.sequence, m.created_at
      FROM agent_run_messages m
      JOIN agent_runs r ON r.id = m.agent_run_id
      WHERE r.session_id = ?
      ORDER BY r.created_at ASC, r.id ASC, m.sequence ASC
    `).all(sessionId) as AgentRunMessageRow[];
  }

  listTasks(sessionId: string): TaskRestoreRow[] {
    return this.db.prepare(`
      SELECT id, session_id, display_number, subject, description, active_form,
             status, created_by_turn_id, completed_by_turn_id, version,
             created_at, updated_at, completed_at
      FROM tasks
      WHERE session_id = ?
      ORDER BY display_number ASC, id ASC
    `).all(sessionId) as TaskRestoreRow[];
  }

  listTaskDependencies(sessionId: string): TaskDependencyRow[] {
    return this.db.prepare(`
      SELECT session_id, blocker_task_id, blocked_task_id, created_at
      FROM task_dependencies
      WHERE session_id = ?
      ORDER BY blocker_task_id ASC, blocked_task_id ASC
    `).all(sessionId) as TaskDependencyRow[];
  }

  getMemoryState(sessionId: string): MemoryStateRow | undefined {
    return this.db.prepare(`
      SELECT session_id, surfaced_json, overrides_json
      FROM memory_session_state WHERE session_id = ?
    `).get(sessionId) as MemoryStateRow | undefined;
  }

  listKbActivations(sessionId: string): KbActivationRow[] {
    return this.db.prepare(`
      SELECT id, call_id, kb_id, asset_id, session_id, turn_id, created_at
      FROM kb_activations WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as KbActivationRow[];
  }

  listUsageRecords(sessionId: string): UsageRecordRow[] {
    return this.db.prepare(`
      SELECT * FROM usage_records
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId) as UsageRecordRow[];
  }

  // ── 导入:完整恢复事务 ──────────────────────────────────────────────────────
  // 文件 I/O(音频、Attachment)由调用方在调用此方法前处理。
  // payload 中所有 localPath / contentPath / storagePath 字段必须已指向磁盘上的文件。

  restoreRows(p: SessionRestorePayload): void {
    validateSessionRestorePayload(p);

    this.db.transaction(() => {
      // 单 Session 备份不包含来源 Session。目标库已有来源时保留 fork 溯源，
      // 否则降级为 NULL，保证备份可独立恢复且不制造悬空外键。
      const forkedFromSessionId = p.session.forkedFromSessionId
        && this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').pluck().get(p.session.forkedFromSessionId)
        ? p.session.forkedFromSessionId
        : null;

      // 1. 恢复 Session 基础行。
      this.db.prepare(`
        INSERT INTO sessions
          (id, title, workspace_root, created_at, updated_at,
           last_activity_at, archived_at, pinned,
           forked_from_session_id, forked_from_turn_id, execution_profile, narrative_policy,
           provider_config_id, model_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.session.id, p.session.title, p.session.workspaceRoot ?? null,
        p.session.createdAt, p.session.updatedAt,
        p.session.lastActivityAt ?? p.session.updatedAt,
        p.session.archivedAt ?? null,
        p.session.pinned ? 1 : 0,
        forkedFromSessionId, null,
        p.session.executionProfile,
        p.session.narrativePolicy,
        p.session.providerConfigId ?? null,
        p.session.modelId ?? null,
      );

      // 2. 恢复线性 Turn。
      const stmtTurn = this.db.prepare(`
        INSERT INTO turns
          (id, session_id, trigger_type, execution_profile, narrative_policy,
           provider_config_id, model_id, status,
           created_at, completed_at, error_code, error_message,
           iterations, usage_input_tokens, usage_output_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of p.turns) {
        stmtTurn.run(
          t.id, p.session.id, t.triggerType,
          t.executionProfile, t.narrativePolicy,
          t.providerConfigId ?? null, t.modelId ?? null,
          t.status, t.createdAt, t.completedAt ?? null,
          t.errorCode ?? null, t.errorMessage ?? null,
          t.iterations ?? 0, t.usageInputTokens ?? 0, t.usageOutputTokens ?? 0,
        );
      }

      // 3. 恢复 Message。
      const stmtMsg = this.db.prepare(`
        INSERT INTO messages
          (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of p.messages) {
        stmtMsg.run(
          m.id, m.sessionId, m.turnId ?? null, m.role, m.kind ?? 'normal',
          m.blocksJson, m.interrupted ? 1 : 0, m.createdAt,
        );
      }

      // 9. 音频合并行(文件已由调用方写入)
      const stmtAudio = this.db.prepare(`
        INSERT INTO speech_outputs
          (turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, segment_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of p.audio) {
        stmtAudio.run(
          r.turnId, p.session.id, r.storagePath,
          r.mimeType, r.byteSize, r.durationMs,
          r.segmentCount, r.createdAt,
        );
      }

      // 10. Attachment(文件已由调用方写入)
      const stmtAtt = this.db.prepare(`
        INSERT INTO attachments
          (id, turn_id, session_id, kind, name, mime, source_path, byte_size, source_modified_at,
           image_path, image_byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of p.attachments) {
        stmtAtt.run(
          a.id, a.turnId, p.session.id, a.kind,
          a.name, a.mime, a.sourcePath, a.byteSize, a.sourceModifiedAt,
          a.imagePath, a.imageByteSize, a.createdAt,
        );
      }

      // 11. Task 与依赖先于 AgentRun 恢复，保证可选 task_id 绑定通过数据库约束。
      const stmtTask = this.db.prepare(`
        INSERT INTO tasks (
          id, session_id, display_number, subject, description, active_form,
          status, created_by_turn_id, completed_by_turn_id, version,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const task of p.tasks) {
        stmtTask.run(
          task.id,
          p.session.id,
          task.display_number,
          task.subject,
          task.description,
          task.active_form,
          task.status,
          task.created_by_turn_id,
          task.completed_by_turn_id,
          task.version,
          task.created_at,
          task.updated_at,
          task.completed_at,
        );
      }

      const stmtTaskDependency = this.db.prepare(`
        INSERT INTO task_dependencies (
          session_id, blocker_task_id, blocked_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const dependency of p.taskDependencies) {
        stmtTaskDependency.run(
          p.session.id,
          dependency.blocker_task_id,
          dependency.blocked_task_id,
          dependency.created_at,
        );
      }

      // 12. 子 Agent 执行
      const stmtAgentRun = this.db.prepare(`
        INSERT INTO agent_runs
          (id, session_id, parent_turn_id, parent_agent_run_id, task_id,
           kind, purpose, provider_config_id, model_id, status, error,
           iterations, tool_call_count, input_tokens, output_tokens, output_excerpt,
           version, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const run of p.agentRuns) {
        stmtAgentRun.run(
          run.id,
          p.session.id,
          run.parent_turn_id,
          run.parent_agent_run_id,
          run.task_id,
          run.kind,
          run.purpose,
          run.provider_config_id,
          run.model_id,
          run.status,
          run.error,
          run.iterations,
          run.tool_call_count,
          run.input_tokens,
          run.output_tokens,
          run.output_excerpt,
          run.version,
          run.created_at,
          run.updated_at,
          run.completed_at,
        );
      }

      // 13. 子 Agent transcript
      const stmtAgentRunMessage = this.db.prepare(`
        INSERT INTO agent_run_messages
          (id, agent_run_id, role, content_json, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const nextAgentRunMessageSequence = new Map<string, number>();
      for (const message of p.agentRunMessages) {
        const nextSequence = nextAgentRunMessageSequence.get(message.agent_run_id) ?? 1;
        // 兼容迁移前导出的旧备份；旧 payload 在运行时没有 sequence 字段。
        const storedSequence = message.sequence;
        const sequence = storedSequence !== undefined
          && Number.isInteger(storedSequence)
          && storedSequence > 0
          ? storedSequence
          : nextSequence;
        stmtAgentRunMessage.run(
          message.id,
          message.agent_run_id,
          message.role,
          message.content_json,
          sequence,
          message.created_at,
        );
        nextAgentRunMessageSequence.set(
          message.agent_run_id,
          Math.max(nextSequence, sequence + 1),
        );
      }

      // 14. Memory session 状态
      if (p.memoryState) {
        this.db.prepare(`
          INSERT INTO memory_session_state (session_id, surfaced_json, overrides_json)
          VALUES (?, ?, ?)
        `).run(p.session.id, p.memoryState.surfaced_json, p.memoryState.overrides_json);
      }

      // 15. KB activation
      const stmtKb = this.db.prepare(`
        INSERT INTO kb_activations
          (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const k of p.kbActivations) {
        stmtKb.run(k.id, k.call_id, k.kb_id, k.asset_id, p.session.id, k.turn_id ?? null, k.created_at);
      }

      // 16. 各类模型调用的用量记录
      const stmtUsageRecord = this.db.prepare(`
        INSERT INTO usage_records (
          id, session_id, turn_id, provider_id, model_id, capability, status,
          input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
          quantity, unit, duration_ms, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of p.usageRecords) {
        stmtUsageRecord.run(
          u.id, p.session.id, u.turn_id, u.provider_id, u.model_id, u.capability, u.status,
          u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_write_input_tokens,
          u.quantity, u.unit, u.duration_ms, u.error_code, u.created_at,
        );
      }

      // 17. Session notes
      if (p.notes) {
        this.db.prepare(`
          INSERT INTO session_notes
            (session_id, body, tokens_at_last_update, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(
          p.session.id, p.notes.body,
          p.notes.tokensAtLastUpdate ?? 0, p.notes.updatedAt,
        );
      }

      // 18. 提交前执行数据库级完整性检查，并核对核心恢复数量。
      const foreignKeyErrors = this.db.pragma('foreign_key_check') as Array<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>;
      if (foreignKeyErrors.length > 0) {
        throw new SessionRestoreValidationError(
          `恢复后外键检查失败: ${JSON.stringify(foreignKeyErrors[0])}`,
        );
      }

      this.assertRestoreCount('turns', p.session.id, p.turns.length);
      this.assertRestoreCount('messages', p.session.id, p.messages.length);
      this.assertRestoreCount('tasks', p.session.id, p.tasks.length);
    })();
  }

  private assertRestoreCount(
    table: 'turns' | 'messages' | 'tasks',
    sessionId: string,
    expected: number,
  ): void {
    const actual = this.db.prepare(
      `SELECT COUNT(*) FROM ${table} WHERE session_id = ?`,
    ).pluck().get(sessionId) as number;
    if (actual !== expected) {
      throw new SessionRestoreValidationError(
        `${table} 恢复数量不一致: expected=${expected}, actual=${actual}`,
      );
    }
  }
}
