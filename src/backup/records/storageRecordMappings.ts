// 把 Storage 的 snake_case 行投影为 ZIP V2 的 camelCase wire 记录，不携带来源机绝对路径。
import type {
  AgentRunMessageRow,
  AgentRunRow,
  AttachmentRow,
  AudioEntryRow,
  BackgroundProcessRow,
  KbActivationRow,
  MemoryStateRow,
  MessageRow,
  SessionBackupToolExecutionRow,
  SessionNoteRow,
  SessionRow,
  TaskDependencyRow,
  TaskRow,
  TurnRow,
  UsageRecordRow,
} from '@ema-agent/storage';
import type {
  AgentRunMessageRecord,
  AgentRunRecord,
  AttachmentRecord,
  AudioRecord,
  BackgroundProcessRecord,
  KbActivationRecord,
  MemoryStateRecord,
  MessageRecord,
  SessionNotesRecord,
  SessionRecord,
  TaskDependencyRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
  UsageRecord,
} from './sessionRecords.js';

export const toSessionRecord = (r: SessionRow): SessionRecord => ({
  id: r.id, title: r.title, sourceWorkspaceRoot: r.workspace_root,
  createdAt: r.created_at, updatedAt: r.updated_at, lastActivityAt: r.last_activity_at,
  archivedAt: r.archived_at, pinned: r.pinned === 1, pinnedAt: r.pinned_at,
  groupLabel: r.group_label, parentSessionId: r.parent_session_id,
  executionProfile: r.execution_profile, narrativePolicy: r.narrative_policy,
  preferredProviderConfigId: r.preferred_provider_config_id,
  preferredModelId: r.preferred_model_id,
});

export const toTurnRecord = (r: TurnRow): TurnRecord => ({
  id: r.id, sessionId: r.session_id, triggerType: r.trigger_type,
  executionProfile: r.execution_profile, narrativePolicy: r.narrative_policy,
  status: r.status, userInput: r.user_input, startedAt: r.started_at,
  completedAt: r.completed_at, errorCode: r.error_code, errorMessage: r.error_message,
  iterations: r.iterations, usageInputTokens: r.usage_input_tokens,
  usageOutputTokens: r.usage_output_tokens,
});

export const toMessageRecord = (r: MessageRow): MessageRecord => ({
  id: r.id, sessionId: r.session_id, turnId: r.turn_id, role: r.role, kind: r.kind,
  blocksJson: r.blocks_json, interrupted: r.interrupted === 1, createdAt: r.created_at,
});

export const toTaskRecord = (r: TaskRow): TaskRecord => ({
  id: r.id, sessionId: r.session_id, displayNumber: r.display_number,
  subject: r.subject, description: r.description, activeForm: r.active_form,
  status: r.status, createdByTurnId: r.created_by_turn_id,
  completedByTurnId: r.completed_by_turn_id, version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

export const toTaskDependencyRecord = (r: TaskDependencyRow): TaskDependencyRecord => ({
  sessionId: r.session_id, blockerTaskId: r.blocker_task_id,
  blockedTaskId: r.blocked_task_id, createdAt: r.created_at,
});

export const toAgentRunRecord = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id, sessionId: r.session_id, parentTurnId: r.parent_turn_id,
  parentAgentRunId: r.parent_agent_run_id, taskId: r.task_id, kind: r.kind,
  purpose: r.purpose, providerConfigId: r.provider_config_id, modelId: r.model_id,
  status: r.status, error: r.error, iterations: r.iterations,
  toolCallCount: r.tool_call_count, inputTokens: r.input_tokens,
  outputTokens: r.output_tokens, outputExcerpt: r.output_excerpt, version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
});

export const toAgentRunMessageRecord = (r: AgentRunMessageRow): AgentRunMessageRecord => ({
  id: r.id, agentRunId: r.agent_run_id, role: r.role,
  contentJson: r.content_json, sequence: r.sequence, createdAt: r.created_at,
});

export const toToolExecutionRecord = (r: SessionBackupToolExecutionRow): ToolExecutionRecord => ({
  callId: r.call_id, sessionId: r.session_id, turnId: r.turn_id,
  agentRunId: r.agent_run_id, toolName: r.tool_name, inputJson: r.input_json,
  inputDigest: r.input_digest, status: r.status, resultPreview: r.result_preview,
  errorCode: r.error_code, errorMessage: r.error_message, startedAt: r.started_at,
  completedAt: r.completed_at, version: r.version, createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toBackgroundProcessRecord = (
  r: BackgroundProcessRow,
  outputDirectoryPath: string,
): BackgroundProcessRecord => ({
  id: r.id, sessionId: r.session_id, originTurnId: r.origin_turn_id,
  toolCallId: r.tool_call_id, command: r.command, description: r.description, cwd: r.cwd,
  status: r.status, timeoutMs: r.timeout_ms, version: r.version, createdAt: r.created_at,
  startedAt: r.started_at, completedAt: r.completed_at, exitCode: r.exit_code,
  terminationReason: r.termination_reason, stdoutBytes: r.stdout_bytes,
  stderrBytes: r.stderr_bytes, outputTruncated: r.output_truncated === 1,
  outputDirectoryPath, completionClaimedAt: r.completion_claimed_at,
  continuationTurnId: r.continuation_turn_id, modelNotifiedAt: r.model_notified_at,
});

export const toAttachmentRecord = (r: AttachmentRow, filePath: string): AttachmentRecord => ({
  id: r.id, turnId: r.turn_id, name: r.name, mime: r.mime, size: r.size,
  mtime: r.mtime, createdAt: r.created_at, filePath,
});

export const toAudioRecord = (r: AudioEntryRow, sessionId: string, filePath: string): AudioRecord => ({
  turnId: r.turn_id, sessionId, mimeType: r.mime_type, byteSize: r.byte_size,
  durationMs: r.duration_ms, segmentCount: r.segment_count,
  createdAt: r.created_at, filePath,
});

export const toUsageRecord = (r: UsageRecordRow): UsageRecord => ({
  id: r.id, sessionId: r.session_id, turnId: r.turn_id, providerId: r.provider_id,
  modelId: r.model_id, capability: r.capability, status: r.status,
  inputTokens: r.input_tokens, outputTokens: r.output_tokens,
  cacheReadInputTokens: r.cache_read_input_tokens,
  cacheWriteInputTokens: r.cache_write_input_tokens, quantity: r.quantity, unit: r.unit,
  costUsd: r.cost_usd, durationMs: r.duration_ms, errorCode: r.error_code,
  createdAt: r.created_at,
});

export const toKbActivationRecord = (r: KbActivationRow): KbActivationRecord => ({
  id: r.id, callId: r.call_id, kbId: r.kb_id, assetId: r.asset_id,
  sessionId: r.session_id, turnId: r.turn_id, createdAt: r.created_at,
});

export const toMemoryStateRecord = (r: MemoryStateRow): MemoryStateRecord => ({
  sessionId: r.session_id, surfacedJson: r.surfaced_json, overridesJson: r.overrides_json,
});

export const toSessionNotesRecord = (r: SessionNoteRow): SessionNotesRecord => ({
  body: r.body, tokensAtLastUpdate: r.tokens_at_last_update, updatedAt: r.updated_at,
});
