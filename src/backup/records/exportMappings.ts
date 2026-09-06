// 把 Storage 行转换为 ZIP 记录，数据库列名和来源机文件路径不进入归档协议。
import type {
  AgentRunMessageRow,
  AgentRunRow,
  AttachmentImageRow,
  AttachmentPastedTextRow,
  BackgroundProcessRow,
  MessageRow,
  SessionBackupTaskRow,
  SessionBackupToolExecutionRow,
  SessionRow,
  SpeechOutputRow,
  SpeechSegmentRow,
  TurnRow,
  UsageRecordRow,
} from '@ema-agent/storage';
import type {
  AgentRunMessageRecord,
  AgentRunRecord,
  AttachmentImageRecord,
  AttachmentPastedTextRecord,
  BackgroundProcessRecord,
  MessageRecord,
  SessionRecord,
  SpeechOutputRecord,
  SpeechSegmentRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
  UsageRecord,
} from './sessionRecords.js';

export const toSessionRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  title: row.title,
  workspaceRoot: row.workspace_root,
  projectId: row.project_id,
  pinned: row.pinned === 1,
  archivedAt: row.archived_at,
  forkedFromSessionId: row.forked_from_session_id,
  forkedFromTurnId: row.forked_from_turn_id,
  lastViewedAt: row.last_viewed_at,
  lastActivityAt: row.last_activity_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  providerId: row.provider_id,
  modelId: row.model_id,
  executionProfile: row.execution_profile,
  narrativePolicy: row.narrative_policy,
});

export const toTurnRecord = (row: TurnRow): TurnRecord => ({
  id: row.id,
  sessionId: row.session_id,
  status: row.status,
  triggerType: row.trigger_type,
  executionProfile: row.execution_profile,
  narrativePolicy: row.narrative_policy,
  providerId: row.provider_id,
  modelId: row.model_id,
  protocol: row.protocol,
  characterDirectoryName: row.character_directory_name,
  iterations: row.iterations,
  usageInputTokens: row.usage_input_tokens,
  usageOutputTokens: row.usage_output_tokens,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  errorCode: row.error_code,
  errorMessage: row.error_message,
});

export const toMessageRecord = (row: MessageRow): MessageRecord => ({
  id: row.id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  role: row.role,
  kind: row.kind,
  blocksJson: row.blocks_json,
  interrupted: row.interrupted === 1,
  createdAt: row.created_at,
  summarizedThroughMessageId: row.summarized_through_message_id,
});

export const toTaskRecord = (row: SessionBackupTaskRow): TaskRecord => ({
  id: row.id,
  sessionId: row.session_id,
  displayNumber: row.display_number,
  subject: row.subject,
  description: row.description,
  activeForm: row.active_form,
  status: row.status,
  createdByTurnId: row.created_by_turn_id,
  completedByTurnId: row.completed_by_turn_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

export const toAgentRunRecord = (row: AgentRunRow): AgentRunRecord => ({
  id: row.id,
  sessionId: row.session_id,
  parentTurnId: row.parent_turn_id,
  parentAgentRunId: row.parent_agent_run_id,
  contextMode: row.context_mode,
  description: row.description,
  providerId: row.provider_id,
  modelId: row.model_id,
  status: row.status,
  error: row.error,
  iterations: row.iterations,
  toolCallCount: row.tool_call_count,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

export const toAgentRunMessageRecord = (row: AgentRunMessageRow): AgentRunMessageRecord => ({
  id: row.id,
  agentRunId: row.agent_run_id,
  role: row.role,
  blockIndex: row.block_index,
  contentJson: row.content_json,
  sequence: row.sequence,
  createdAt: row.created_at,
});

export const toToolExecutionRecord = (
  row: SessionBackupToolExecutionRow,
): ToolExecutionRecord => ({
  callId: row.call_id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  agentRunId: row.agent_run_id,
  toolName: row.tool_name,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toBackgroundProcessRecord = (
  row: BackgroundProcessRow,
  outputDirectoryPath: string,
): BackgroundProcessRecord => ({
  id: row.id,
  sessionId: row.session_id,
  originTurnId: row.origin_turn_id,
  toolCallId: row.tool_call_id,
  command: row.command,
  description: row.description,
  cwd: row.cwd,
  status: row.status,
  timeoutMs: row.timeout_ms,
  version: row.version,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  exitCode: row.exit_code,
  terminationReason: row.termination_reason,
  stdoutBytes: row.stdout_bytes,
  stderrBytes: row.stderr_bytes,
  outputTruncated: row.output_truncated === 1,
  outputDirectoryPath,
  completionClaimedAt: row.completion_claimed_at,
  continuationTurnId: row.continuation_turn_id,
  modelNotifiedAt: row.model_notified_at,
});

export const toAttachmentImageRecord = (
  row: AttachmentImageRow,
  filePath: string,
): AttachmentImageRecord => ({
  path: row.path,
  turnId: row.turn_id,
  name: row.name,
  byteSize: row.byte_size,
  createdAt: row.created_at,
  filePath,
});

export const toAttachmentPastedTextRecord = (
  row: AttachmentPastedTextRow,
  filePath: string,
): AttachmentPastedTextRecord => ({
  path: row.path,
  turnId: row.turn_id,
  byteSize: row.byte_size,
  createdAt: row.created_at,
  filePath,
});

export const toSpeechOutputRecord = (
  row: SpeechOutputRow,
  filePath: string,
): SpeechOutputRecord => ({
  turnId: row.turn_id,
  sessionId: row.session_id,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  durationMs: row.duration_ms,
  segmentCount: row.segment_count,
  createdAt: row.created_at,
  filePath,
});

export const toSpeechSegmentRecord = (
  row: SpeechSegmentRow,
  filePath: string,
): SpeechSegmentRecord => ({
  id: row.id,
  turnId: row.turn_id,
  sessionId: row.session_id,
  sentenceIndex: row.sentence_index,
  mimeType: row.mime_type,
  byteSize: row.byte_size,
  durationMs: row.duration_ms,
  text: row.text,
  createdAt: row.created_at,
  filePath,
});

export const toUsageRecord = (row: UsageRecordRow): UsageRecord => ({
  id: row.id,
  sessionId: row.session_id!,
  turnId: row.turn_id,
  providerId: row.provider_id,
  modelId: row.model_id,
  capability: row.capability,
  status: row.status,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadInputTokens: row.cache_read_input_tokens,
  cacheWriteInputTokens: row.cache_write_input_tokens,
  quantity: row.quantity,
  unit: row.unit,
  durationMs: row.duration_ms,
  errorCode: row.error_code,
  createdAt: row.created_at,
});
