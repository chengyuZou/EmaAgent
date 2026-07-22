// 汇总数据目录与 Session 统计，并执行完整 Session 备份恢复事务。
import type { SqliteDb } from '../database.js';
import type { ExecutionProfile, NarrativePolicy, TurnTriggerType } from '@ema-agent/turn';
import type { AgentTaskMessageRow } from './agent-task-messages.js';
import type { KbActivationRow }     from './kb-activations.js';
import type { AgentTaskRow }        from './agent-tasks.js';
import type { UsageRecordRow }      from './usage-records.js';
import type { BranchRow }           from './branches.js';

export type { AgentTaskMessageRow, KbActivationRow, AgentTaskRow, UsageRecordRow, BranchRow };

// ════════════════════════════════════════════════════════════════════════════
// DataDir 级聚合统计
// ════════════════════════════════════════════════════════════════════════════

export interface DataDirStats {
  sessionCount:    number;
  turnCount:       number;
  messageCount:    number;
  artifactCount:   number;
  agentTaskCount:  number;
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
        (SELECT COUNT(*) FROM artifacts)   AS artifact_count,
        (SELECT COUNT(*) FROM agent_tasks) AS agent_task_count,
        (SELECT COUNT(*)                      FROM turn_audio_merged) AS audio_count,
        (SELECT COALESCE(SUM(duration_ms), 0) FROM turn_audio_merged) AS audio_duration_ms
    `).get() as {
      session_count: number; turn_count: number; message_count: number;
      artifact_count: number; agent_task_count: number;
      audio_count: number; audio_duration_ms: number;
    };
    return {
      sessionCount:    row.session_count,
      turnCount:       row.turn_count,
      messageCount:    row.message_count,
      artifactCount:   row.artifact_count,
      agentTaskCount:  row.agent_task_count,
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
  narrativeTurns:       number;
  agentTurns:           number;
  branchCount:          number;
  artifactCount:        number;
  artifactInlineBytes:  number;
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

export interface ArtifactSummaryRow {
  id:               string;
  type:             string;
  title:            string;
  content_location: string;
  byte_size:        number;
  created_at:       number;
  applied_at:       number | null;
  rejected_at:      number | null;
}

export interface MemoryStateRow {
  session_id:     string;
  surfaced_json:  string;
  overrides_json: string;
}

// ── 导入(恢复)payload 类型 ───────────────────────────────────────────────────

export interface TurnRestoreRow {
  id: string; sessionId: string; branchId: string | null;
  triggerType: TurnTriggerType;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  status: string; userInput: string; startedAt: number;
  completedAt: number | null; errorCode: string | null; errorMessage: string | null;
  iterations: number; usageInputTokens: number; usageOutputTokens: number;
}

export interface MessageRestoreRow {
  id: string; sessionId: string; turnId: string | null;
  role: string; kind: string; blocksJson: string;
  interrupted: boolean; createdAt: number;
  metaJson?: string;
}

export interface ArtifactRestoreRow {
  id: string; sessionId: string; turnId: string | null; type: string; title: string; contentLocation: string;
  content: string | null;
  contentPath: string | null;
  createdAt: number; appliedAt: number | null; rejectedAt: number | null;
  metaJson?: string;
}

export interface AudioRestoreRow {
  turnId: string; sessionId: string; storagePath: string;
  mimeType: string; byteSize: number; durationMs: number | null;
  segmentCount: number; createdAt: number;
}

export interface AttachmentRestoreRow {
  id: string; turnId: string; name: string; mime: string;
  size: number; mtime: number; localPath: string; createdAt: number;
}

export interface NotesRestoreData {
  body: string; tokensAtLastUpdate: number; updatedAt: number;
}

export interface SessionRestorePayload {
  session: {
    id: string; title: string;
    workspaceRoot: string | null; createdAt: number; updatedAt: number;
    lastActivityAt: number; archivedAt: number | null;
    pinned: boolean; pinnedAt: number | null;
    groupLabel: string | null; parentSessionId: string | null;
    executionProfile: ExecutionProfile;
    narrativePolicy: NarrativePolicy;
    activeBranchId: string | null;
    /** 旧 ZIP v1 没有这两个字段，导入时按 null 兼容。 */
    preferredProviderConfigId?: string | null;
    preferredModelId?: string | null;
  };
  branches:          BranchRow[];
  turns:             TurnRestoreRow[];
  messages:          MessageRestoreRow[];
  artifacts:         ArtifactRestoreRow[];
  audio:             AudioRestoreRow[];
  attachments:       AttachmentRestoreRow[];
  agentTasks:        AgentTaskRow[];
  agentTaskMessages: AgentTaskMessageRestoreRow[];
  memoryState:       MemoryStateRow | null;
  kbActivations:     KbActivationRow[];
  usageRecords:      UsageRecordRow[];
  notes:             NotesRestoreData | null;
}

/** sequence 可选以兼容 data v9 之前导出的 Session 备份。 */
export type AgentTaskMessageRestoreRow =
  Omit<AgentTaskMessageRow, 'sequence'> & { sequence?: number };

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
  if (payload.session.parentSessionId === sessionId) {
    throw new SessionRestoreValidationError('Session 不能把自身设为 parentSessionId');
  }
  const preferredProviderConfigId = payload.session.preferredProviderConfigId ?? null;
  const preferredModelId = payload.session.preferredModelId ?? null;
  if ((preferredProviderConfigId === null) !== (preferredModelId === null)) {
    throw new SessionRestoreValidationError('Session 下一轮模型偏好必须同时包含供应商配置和模型');
  }
  if (preferredProviderConfigId !== null && (!preferredProviderConfigId.trim() || !preferredModelId?.trim())) {
    throw new SessionRestoreValidationError('Session 下一轮模型偏好不能为空字符串');
  }

  const turnIds = uniqueIds(payload.turns, 'Turn');
  const branchIds = uniqueIds(payload.branches, 'Branch');
  const taskIds = uniqueIds(payload.agentTasks, 'AgentTask');
  uniqueIds(payload.messages, 'Message');
  uniqueIds(payload.artifacts, 'Artifact');
  uniqueIds(payload.attachments, 'Attachment');
  uniqueIds(payload.agentTaskMessages, 'AgentTaskMessage');
  uniqueIds(payload.kbActivations, 'KbActivation');

  for (const turn of payload.turns) {
    assertSessionOwnership('Turn', turn.id, turn.sessionId, sessionId);
    assertOptionalReference('Turn.branchId', turn.id, turn.branchId, branchIds);
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
  for (const branch of payload.branches) {
    assertSessionOwnership('Branch', branch.id, branch.session_id, sessionId);
    assertOptionalReference('Branch.parentBranchId', branch.id, branch.parent_branch_id, branchIds);
    assertOptionalReference('Branch.forkFromTurnId', branch.id, branch.fork_from_turn_id, turnIds);
  }
  assertOptionalReference('Session.activeBranchId', sessionId, payload.session.activeBranchId, branchIds);
  assertBranchParentGraph(payload.branches);

  for (const message of payload.messages) {
    assertSessionOwnership('Message', message.id, message.sessionId, sessionId);
    assertOptionalReference('Message.turnId', message.id, message.turnId, turnIds);
  }
  for (const artifact of payload.artifacts) {
    assertSessionOwnership('Artifact', artifact.id, artifact.sessionId, sessionId);
    assertOptionalReference('Artifact.turnId', artifact.id, artifact.turnId, turnIds);
  }
  for (const audio of payload.audio) {
    assertSessionOwnership('Audio', audio.turnId, audio.sessionId, sessionId);
    assertReference('Audio.turnId', audio.turnId, audio.turnId, turnIds);
  }
  for (const attachment of payload.attachments) {
    assertReference('Attachment.turnId', attachment.id, attachment.turnId, turnIds);
  }
  for (const task of payload.agentTasks) {
    assertSessionOwnership('AgentTask', task.id, task.session_id, sessionId);
    assertOptionalReference('AgentTask.turnId', task.id, task.turn_id, turnIds);
    assertOptionalReference('AgentTask.parentId', task.id, task.parent_id, taskIds);
  }
  for (const message of payload.agentTaskMessages) {
    assertReference('AgentTaskMessage.taskId', message.id, message.task_id, taskIds);
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

function assertBranchParentGraph(branches: readonly BranchRow[]): void {
  const parents = new Map(branches.map(branch => [branch.id, branch.parent_branch_id]));
  const complete = new Set<string>();

  for (const branch of branches) {
    if (complete.has(branch.id)) continue;
    const path = new Set<string>();
    let current: string | null = branch.id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current)) {
        throw new SessionRestoreValidationError(`Branch parent graph 存在循环: ${current}`);
      }
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const id of path) complete.add(id);
  }
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
          WHERE session_id = ? AND execution_profile = 'chat' AND narrative_policy <> 'always') AS chat_turns,
        (SELECT COUNT(*) FROM turns
          WHERE session_id = ? AND execution_profile = 'chat' AND narrative_policy = 'always') AS narrative_turns,
        (SELECT COUNT(*) FROM turns WHERE session_id = ? AND execution_profile = 'work') AS agent_turns,
        (SELECT COUNT(*) FROM branches WHERE session_id = ?) AS branch_count,
        (SELECT COUNT(*) FROM artifacts WHERE session_id = ?) AS artifact_count,
        (SELECT COALESCE(SUM(LENGTH(COALESCE(content,''))), 0)
           FROM artifacts WHERE session_id = ? AND content_location = 'inline') AS artifact_inline_bytes,
        (SELECT COUNT(*)                   FROM turn_audio_merged  WHERE session_id = ?) AS audio_turn_count,
        (SELECT COALESCE(SUM(byte_size),0) FROM turn_audio_merged  WHERE session_id = ?) AS audio_total_bytes,
        (SELECT COALESCE(SUM(duration_ms),0) FROM turn_audio_merged WHERE session_id = ?) AS audio_total_duration_ms,
        (SELECT COUNT(*)              FROM turn_attachments WHERE session_id = ?) AS attachment_count,
        (SELECT COALESCE(SUM(size),0) FROM turn_attachments WHERE session_id = ?) AS attachment_total_bytes
    `).get(
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId, sessionId, sessionId,
      sessionId, sessionId,
      sessionId, sessionId, sessionId,
      sessionId, sessionId,
    ) as {
      turn_count: number; message_count: number;
      total_input_tokens: number; total_output_tokens: number;
      chat_turns: number; narrative_turns: number; agent_turns: number;
      branch_count: number;
      artifact_count: number; artifact_inline_bytes: number;
      audio_turn_count: number; audio_total_bytes: number; audio_total_duration_ms: number;
      attachment_count: number; attachment_total_bytes: number;
    };

    return {
      turnCount:            row.turn_count,
      messageCount:         row.message_count,
      totalInputTokens:     row.total_input_tokens,
      totalOutputTokens:    row.total_output_tokens,
      chatTurns:            row.chat_turns,
      narrativeTurns:       row.narrative_turns,
      agentTurns:           row.agent_turns,
      branchCount:          row.branch_count,
      artifactCount:        row.artifact_count,
      artifactInlineBytes:  row.artifact_inline_bytes,
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
      FROM turn_audio_merged
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as AudioEntryRow[];
  }

  /**
   * 记录一个 turn 的合并音频文件。由 orchestrator 在 TTS 完成合并文件后调用--
   * 不调用的话,仪表盘统计和导出 zip 看不到音频,即使文件已在磁盘上。
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
      INSERT OR REPLACE INTO turn_audio_merged
        (turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, segment_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.turnId, row.sessionId, row.storagePath, row.mimeType,
      row.byteSize, row.durationMs, row.segmentCount, row.createdAt,
    );
  }

  listArtifactSummaries(sessionId: string): ArtifactSummaryRow[] {
    return this.db.prepare(`
      SELECT id, type, title, content_location,
             CASE WHEN content_location = 'inline'
                  THEN LENGTH(COALESCE(content, ''))
                  ELSE 0
             END AS byte_size,
             created_at, applied_at, rejected_at
      FROM artifacts
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as ArtifactSummaryRow[];
  }

  listBranches(sessionId: string): BranchRow[] {
    return this.db.prepare(`
      SELECT id, parent_branch_id, fork_from_turn_id, created_at
      FROM branches WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as BranchRow[];
  }

  listAgentTasks(sessionId: string): AgentTaskRow[] {
    return this.db.prepare(`
      SELECT id, session_id, turn_id, parent_id, status, error,
             version, iterations, input_tokens, output_tokens, created_at, updated_at
      FROM agent_tasks WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as AgentTaskRow[];
  }

  listAgentTaskMessages(sessionId: string): AgentTaskMessageRow[] {
    return this.db.prepare(`
      SELECT m.id, m.task_id, m.role, m.content_json, m.sequence, m.created_at
      FROM agent_task_messages m
      JOIN agent_tasks t ON t.id = m.task_id
      WHERE t.session_id = ?
      ORDER BY t.created_at ASC, t.id ASC, m.sequence ASC
    `).all(sessionId) as AgentTaskMessageRow[];
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
  // 文件 I/O(音频、Artifact、Attachment)由调用方在调用此方法前处理。
  // payload 中所有 localPath / contentPath / storagePath 字段必须已指向磁盘上的文件。

  restoreRows(p: SessionRestorePayload): void {
    validateSessionRestorePayload(p);

    this.db.transaction(() => {
      // 单 Session 备份不包含来源 Session。目标库已有来源时保留 fork 溯源，
      // 否则降级为 NULL，保证备份可独立恢复且不制造悬空外键。
      const parentSessionId = p.session.parentSessionId
        && this.db.prepare('SELECT 1 FROM sessions WHERE id = ?').pluck().get(p.session.parentSessionId)
        ? p.session.parentSessionId
        : null;

      // 1. Session--active_branch_id 先置 NULL(循环 FK:session->branch, branch->session)
      this.db.prepare(`
        INSERT INTO sessions
          (id, title, workspace_root, created_at, updated_at,
           last_activity_at, archived_at, pinned, pinned_at, group_label,
           parent_session_id, execution_profile, narrative_policy,
           preferred_provider_config_id, preferred_model_id,
           active_branch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        p.session.id, p.session.title, p.session.workspaceRoot ?? null,
        p.session.createdAt, p.session.updatedAt,
        p.session.lastActivityAt ?? p.session.updatedAt,
        p.session.archivedAt ?? null,
        p.session.pinned ? 1 : 0, p.session.pinnedAt ?? null,
        p.session.groupLabel ?? null, parentSessionId,
        p.session.executionProfile,
        p.session.narrativePolicy,
        p.session.preferredProviderConfigId ?? null,
        p.session.preferredModelId ?? null,
      );

      // 2. 先插入 Turn 节点，但暂不恢复 branch_id，打断 Turn -> Branch 的环。
      const stmtTurn = this.db.prepare(`
        INSERT INTO turns
          (id, session_id, trigger_type, execution_profile, narrative_policy,
           branch_id, status, user_input,
           started_at, completed_at, error_code, error_message,
           iterations, usage_input_tokens, usage_output_tokens)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of p.turns) {
        stmtTurn.run(
          t.id, p.session.id, t.triggerType, t.executionProfile, t.narrativePolicy,
          t.status, t.userInput, t.startedAt, t.completedAt ?? null,
          t.errorCode ?? null, t.errorMessage ?? null,
          t.iterations ?? 0, t.usageInputTokens ?? 0, t.usageOutputTokens ?? 0,
        );
      }

      // 3. 再插入 Branch 节点，parent/fork 暂置 NULL，消除数组顺序依赖。
      const stmtBranch = this.db.prepare(`
        INSERT INTO branches (id, session_id, parent_branch_id, fork_from_turn_id, created_at)
        VALUES (?, ?, NULL, NULL, ?)
      `);
      for (const b of p.branches) {
        stmtBranch.run(b.id, p.session.id, b.created_at);
      }

      // 4. 所有节点已存在，恢复 Branch 的父节点与 fork Turn 引用。
      const stmtBranchRefs = this.db.prepare(`
        UPDATE branches
        SET parent_branch_id = ?, fork_from_turn_id = ?
        WHERE id = ? AND session_id = ?
      `);
      for (const b of p.branches) {
        const info = stmtBranchRefs.run(
          b.parent_branch_id ?? null,
          b.fork_from_turn_id ?? null,
          b.id,
          p.session.id,
        );
        if (info.changes !== 1) {
          throw new SessionRestoreValidationError(`恢复 Branch 引用失败: ${b.id}`);
        }
      }

      // 5. 恢复 Turn -> Branch 引用。
      const stmtTurnBranch = this.db.prepare(`
        UPDATE turns SET branch_id = ? WHERE id = ? AND session_id = ?
      `);
      for (const t of p.turns) {
        if (t.branchId === null) continue;
        const info = stmtTurnBranch.run(t.branchId, t.id, p.session.id);
        if (info.changes !== 1) {
          throw new SessionRestoreValidationError(`恢复 Turn branch 引用失败: ${t.id}`);
        }
      }

      // 6. 最后恢复 Session -> active Branch 引用。
      if (p.session.activeBranchId) {
        const info = this.db.prepare(
          'UPDATE sessions SET active_branch_id = ? WHERE id = ?',
        ).run(p.session.activeBranchId, p.session.id);
        if (info.changes !== 1) {
          throw new SessionRestoreValidationError(`恢复 active Branch 失败: ${p.session.activeBranchId}`);
        }
      }

      // 7. Message
      const stmtMsg = this.db.prepare(`
        INSERT INTO messages
          (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of p.messages) {
        stmtMsg.run(
          m.id, m.sessionId, m.turnId ?? null, m.role, m.kind ?? 'normal',
          m.blocksJson, m.interrupted ? 1 : 0, m.createdAt,
          m.metaJson ?? '{}',
        );
      }

      // 8. Artifact
      const stmtArt = this.db.prepare(`
        INSERT INTO artifacts
          (id, session_id, turn_id, type, title, content, content_location,
           content_path, meta_json, created_at, updated_at, applied_at, rejected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of p.artifacts) {
        stmtArt.run(
          a.id, p.session.id, a.turnId ?? null, a.type, a.title,
          a.content, a.contentLocation,
          a.contentPath ?? null,
          a.metaJson ?? '{}',
          a.createdAt, a.createdAt,
          a.appliedAt ?? null, a.rejectedAt ?? null,
        );
      }

      // 9. 音频合并行(文件已由调用方写入)
      const stmtAudio = this.db.prepare(`
        INSERT INTO turn_audio_merged
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
        INSERT INTO turn_attachments
          (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of p.attachments) {
        stmtAtt.run(
          a.id, a.turnId, p.session.id,
          a.name, a.mime, a.size, a.mtime ?? 0,
          a.localPath, a.createdAt,
        );
      }

      // 11. Agent task
      const stmtTask = this.db.prepare(`
        INSERT INTO agent_tasks
          (id, session_id, turn_id, parent_id, status,
           version, error, iterations, input_tokens, output_tokens, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of p.agentTasks) {
        stmtTask.run(
          t.id, p.session.id, t.turn_id ?? null, t.parent_id ?? null,
          t.status, t.version ?? 0,
          t.error ?? null, t.iterations ?? null,
          t.input_tokens ?? null, t.output_tokens ?? null,
          t.created_at, t.updated_at,
        );
      }

      // 12. Agent task message
      const stmtTaskMsg = this.db.prepare(`
        INSERT INTO agent_task_messages
          (id, task_id, role, content_json, sequence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const nextTaskMessageSequence = new Map<string, number>();
      for (const m of p.agentTaskMessages) {
        const nextSequence = nextTaskMessageSequence.get(m.task_id) ?? 1;
        // 兼容迁移前导出的旧备份；旧 payload 在运行时没有 sequence 字段。
        const storedSequence = m.sequence;
        const sequence = storedSequence !== undefined
          && Number.isInteger(storedSequence)
          && storedSequence > 0
          ? storedSequence
          : nextSequence;
        stmtTaskMsg.run(
          m.id,
          m.task_id,
          m.role,
          m.content_json,
          sequence,
          m.created_at,
        );
        nextTaskMessageSequence.set(m.task_id, Math.max(nextSequence, sequence + 1));
      }

      // 13. Memory session 状态
      if (p.memoryState) {
        this.db.prepare(`
          INSERT INTO memory_session_state (session_id, surfaced_json, overrides_json)
          VALUES (?, ?, ?)
        `).run(p.session.id, p.memoryState.surfaced_json, p.memoryState.overrides_json);
      }

      // 14. KB activation
      const stmtKb = this.db.prepare(`
        INSERT INTO kb_activations
          (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const k of p.kbActivations) {
        stmtKb.run(k.id, k.call_id, k.kb_id, k.asset_id, p.session.id, k.turn_id ?? null, k.created_at);
      }

      // 15. 各类模型调用的用量记录
      const stmtUsageRecord = this.db.prepare(`
        INSERT INTO usage_records (
          id, session_id, turn_id, provider_id, model_id, capability, status,
          input_tokens, output_tokens, cache_read_input_tokens, cache_write_input_tokens,
          quantity, unit, cost_usd, duration_ms, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of p.usageRecords) {
        stmtUsageRecord.run(
          u.id, p.session.id, u.turn_id, u.provider_id, u.model_id, u.capability, u.status,
          u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_write_input_tokens,
          u.quantity, u.unit, u.cost_usd, u.duration_ms, u.error_code, u.created_at,
        );
      }

      // 16. Session notes
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

      // 17. 提交前执行数据库级完整性检查，并核对核心恢复数量。
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
      this.assertRestoreCount('branches', p.session.id, p.branches.length);
      this.assertRestoreCount('messages', p.session.id, p.messages.length);
    })();
  }

  private assertRestoreCount(table: 'turns' | 'branches' | 'messages', sessionId: string, expected: number): void {
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
