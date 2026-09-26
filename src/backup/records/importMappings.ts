// 把已校验的 ZIP 记录转换为 Storage 行，并收口来源机未完成的执行状态。
import type {
  SubagentMessageRow,
  SubagentRow,
  SubagentInvocationRow,
  AttachmentImageRow,
  AttachmentPastedTextRow,
  BackgroundProcessRow,
  MessageRow,
  SessionBackupRestoreRows,
  SessionBackupTaskRow,
  SessionBackupToolExecutionRow,
  SessionRow,
  SpeechOutputRow,
  TurnRow,
  UsageRecordRow,
} from '@ema-agent/storage';
import type {
  SubagentMessageRecord,
  SubagentRecord,
  SubagentInvocationRecord,
  AttachmentImageRecord,
  AttachmentPastedTextRecord,
  BackgroundProcessRecord,
  MessageRecord,
  SessionRecord,
  SpeechOutputRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
  UsageRecord,
} from './sessionRecords.js';

export type RestoreRows = SessionBackupRestoreRows;

export function restoreSessionRecord(record: SessionRecord): SessionRow {
  return {
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    project_id: record.projectId,
    pinned: record.pinned ? 1 : 0,
    archived_at: record.archivedAt,
    forked_from_session_id: record.forkedFromSessionId,
    forked_from_turn_id: record.forkedFromTurnId,
    last_viewed_at: record.lastViewedAt,
    last_activity_at: record.lastActivityAt,
    // 单条 Session 备份不保存它在来源机侧栏中的位置.
    sidebar_order: 0,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    provider_id: record.providerId,
    model_id: record.modelId,
    reasoning_effort: record.reasoningEffort,
    session_mode: record.sessionMode,
    narrative_policy: record.narrativePolicy,
    permission_mode: record.permissionMode,
    tts_enabled: record.ttsEnabled ? 1 : 0,
  };
}

export function restoreTurnRecord(record: TurnRecord, importedAt: number): TurnRow {
  const unfinished = record.status === 'running';
  return {
    id: record.id,
    session_id: record.sessionId,
    status: unfinished ? 'aborted' : record.status,
    trigger_type: record.triggerType,
    session_mode: record.sessionMode,
    narrative_policy: record.narrativePolicy,
    tts_enabled: record.ttsEnabled ? 1 : 0,
    provider_id: record.providerId,
    model_id: record.modelId,
    protocol: record.protocol ?? null,
    character_name: record.characterName,
    iterations: record.iterations,
    created_at: record.createdAt,
    completed_at: unfinished ? record.completedAt ?? importedAt : record.completedAt,
    error_code: unfinished ? 'backup/import_interrupted' : record.errorCode,
    error_message: unfinished
      ? 'Turn 导出时尚未完成，导入后不会继续执行'
      : record.errorMessage,
  };
}

export const restoreMessageRecord = (record: MessageRecord): MessageRow => ({
  id: record.id,
  session_id: record.sessionId,
  turn_id: record.turnId,
  role: record.role,
  kind: record.kind,
  blocks_json: record.blocksJson,
  interrupted: record.interrupted ? 1 : 0,
  created_at: record.createdAt,
  summarized_through_message_id: record.summarizedThroughMessageId ?? null,
});

export function restoreTaskRecord(record: TaskRecord): SessionBackupTaskRow {
  const unfinished = record.status === 'in_progress';
  return {
    id: record.id,
    session_id: record.sessionId,
    display_number: record.displayNumber,
    subject: record.subject,
    description: record.description,
    active_form: record.activeForm,
    status: unfinished ? 'pending' : record.status,
    created_by_turn_id: record.createdByTurnId,
    completed_by_turn_id: record.completedByTurnId,
    version: unfinished ? record.version + 1 : record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    completed_at: record.completedAt,
  };
}

export function restoreSubagentRecord(record: SubagentRecord, importedAt: number): SubagentRow {
  const unfinished = record.status === 'running';
  return {
    id: record.id,
    session_id: record.sessionId,
    context_mode: record.contextMode,
    description: record.description,
    provider_id: record.providerId,
    model_id: record.modelId,
    status: unfinished ? 'cancelled' : record.status,
    error: unfinished ? 'Subagent 导出时尚未完成，导入后不会继续执行' : record.error,
    iterations: record.iterations,
    tool_call_count: record.toolCallCount,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    final_text: record.finalText,
    created_at: record.createdAt,
    updated_at: unfinished ? Math.max(record.updatedAt, importedAt) : record.updatedAt,
    completed_at: unfinished ? record.completedAt ?? importedAt : record.completedAt,
  };
}

export const restoreSubagentInvocationRecord = (
  record: SubagentInvocationRecord,
): SubagentInvocationRow => ({
  tool_call_id: record.toolCallId,
  subagent_id: record.subagentId,
  created_at: record.createdAt,
});

export const restoreSubagentMessageRecord = (
  record: SubagentMessageRecord,
): SubagentMessageRow => ({
  id: record.id,
  subagent_id: record.subagentId,
  role: record.role,
  kind: record.kind,
  blocks_json: record.blocksJson,
  interrupted: record.interrupted ? 1 : 0,
  sequence: record.sequence,
  created_at: record.createdAt,
  summarized_through_message_id: record.summarizedThroughMessageId,
});

export function restoreToolExecutionRecord(
  record: ToolExecutionRecord,
  importedAt: number,
): SessionBackupToolExecutionRow {
  const unfinished = ['prepared', 'authorized', 'running'].includes(record.status);
  let status: SessionBackupToolExecutionRow['status'] = record.status;
  if (unfinished) {
    status = record.status === 'running' ? 'outcome_unknown' : 'cancelled';
  }
  return {
    call_id: record.callId,
    session_id: record.sessionId,
    turn_id: record.turnId,
    subagent_id: record.subagentId,
    tool_name: record.toolName,
    status,
    started_at: record.startedAt,
    completed_at: unfinished ? record.completedAt ?? importedAt : record.completedAt,
    version: unfinished ? record.version + 1 : record.version,
    created_at: record.createdAt,
    updated_at: unfinished ? Math.max(record.updatedAt, importedAt) : record.updatedAt,
  };
}

export function restoreBackgroundProcessRecord(
  record: BackgroundProcessRecord,
  outputRelativePath: string,
  stdoutBytes: number,
  stderrBytes: number,
  importedAt: number,
): BackgroundProcessRow {
  const unfinished = record.status === 'queued' || record.status === 'running';
  return {
    id: record.id,
    session_id: record.sessionId,
    origin_turn_id: record.originTurnId,
    tool_call_id: record.toolCallId,
    command: record.command,
    description: record.description,
    cwd: record.cwd,
    status: unfinished ? 'interrupted' : record.status,
    timeout_ms: record.timeoutMs,
    version: unfinished ? record.version + 1 : record.version,
    created_at: record.createdAt,
    started_at: record.startedAt,
    completed_at: unfinished ? record.completedAt ?? importedAt : record.completedAt,
    exit_code: record.exitCode,
    termination_reason: unfinished
      ? '后台进程导出时尚未完成，导入后不会重新启动'
      : record.terminationReason,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    output_truncated: record.outputTruncated
      || stdoutBytes !== record.stdoutBytes
      || stderrBytes !== record.stderrBytes ? 1 : 0,
    output_relative_path: outputRelativePath,
  };
}

export const restoreAttachmentImageRecord = (
  record: AttachmentImageRecord,
  newPath: string,
  sessionId: string,
): AttachmentImageRow => ({
  path: newPath,
  session_id: sessionId,
  turn_id: record.turnId,
  name: record.name,
  byte_size: record.byteSize,
  created_at: record.createdAt,
});

export const restoreAttachmentPastedTextRecord = (
  record: AttachmentPastedTextRecord,
  newPath: string,
  sessionId: string,
): AttachmentPastedTextRow => ({
  path: newPath,
  session_id: sessionId,
  turn_id: record.turnId,
  byte_size: record.byteSize,
  created_at: record.createdAt,
});

export const restoreSpeechOutputRecord = (
  record: SpeechOutputRecord,
  filePath: string,
): SpeechOutputRow => ({
  turn_id: record.turnId,
  session_id: record.sessionId,
  storage_path: filePath,
  mime_type: record.mimeType,
  byte_size: record.byteSize,
  duration_ms: record.durationMs,
  segment_count: record.segmentCount,
  created_at: record.createdAt,
});

export const restoreUsageRecord = (record: UsageRecord): UsageRecordRow => ({
  id: record.id,
  session_id: record.sessionId,
  turn_id: record.turnId,
  provider_id: record.providerId,
  model_id: record.modelId,
  capability: record.capability,
  status: record.status,
  input_tokens: record.inputTokens,
  output_tokens: record.outputTokens,
  cache_read_input_tokens: record.cacheReadInputTokens,
  cache_write_input_tokens: record.cacheWriteInputTokens,
  quantity: record.quantity,
  unit: record.unit,
  duration_ms: record.durationMs,
  error_code: record.errorCode,
  created_at: record.createdAt,
});
