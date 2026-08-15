// 把已校验并冻结的备份 wire 记录投影为 Storage 恢复命令，不把归档类型泄漏进数据库包。
import type {
  AgentRunMessageRow,
  AgentRunRow,
  BackgroundProcessRow,
  KbActivationRow,
  MessageRestoreRow,
  SessionBackupToolExecutionRow,
  TaskDependencyRow,
  TaskRow,
  TurnRestoreRow,
  UsageRecordRow,
} from '@ema-agent/storage';
import {
  asAgentRunId,
  asSessionId,
  asTaskId,
  asTurnId,
} from '@ema-agent/ids';
import {
  freezeAgentRun,
  freezeBackgroundProcess,
  freezeTask,
  freezeToolExecution,
  freezeTurn,
} from '../state/freezeExecution.js';
import type {
  AgentRunMessageRecord,
  AgentRunRecord,
  BackgroundProcessRecord,
  KbActivationRecord,
  MessageRecord,
  TaskDependencyRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
  UsageRecord,
} from './sessionRecords.js';

export const restoreTurn = (record: TurnRecord, importedAt: number): TurnRestoreRow => {
  const row = freezeTurn(record, importedAt);
  return {
    id: row.id, sessionId: row.sessionId, triggerType: row.triggerType,
    executionProfile: row.executionProfile, narrativePolicy: row.narrativePolicy,
    status: row.status, userInput: row.userInput, startedAt: row.startedAt,
    completedAt: row.completedAt, errorCode: row.errorCode, errorMessage: row.errorMessage,
    iterations: row.iterations, usageInputTokens: row.usageInputTokens,
    usageOutputTokens: row.usageOutputTokens,
  };
};

export const restoreMessage = (r: MessageRecord): MessageRestoreRow => ({
  id: r.id, sessionId: r.sessionId, turnId: r.turnId, role: r.role, kind: r.kind,
  blocksJson: r.blocksJson, interrupted: r.interrupted, createdAt: r.createdAt,
});

export const restoreTask = (record: TaskRecord): Omit<TaskRow, 'active_agent_run_id'> => {
  const r = freezeTask(record);
  return {
    id: asTaskId(r.id), session_id: asSessionId(r.sessionId), display_number: r.displayNumber,
    subject: r.subject, description: r.description, active_form: r.activeForm,
    status: r.status, created_by_turn_id: asTurnId(r.createdByTurnId),
    completed_by_turn_id: r.completedByTurnId ? asTurnId(r.completedByTurnId) : null,
    version: r.version, created_at: r.createdAt, updated_at: r.updatedAt,
    completed_at: r.completedAt,
  };
};

export const restoreTaskDependency = (r: TaskDependencyRecord): TaskDependencyRow => ({
  session_id: asSessionId(r.sessionId), blocker_task_id: asTaskId(r.blockerTaskId),
  blocked_task_id: asTaskId(r.blockedTaskId), created_at: r.createdAt,
});

export const restoreAgentRun = (record: AgentRunRecord, importedAt: number): AgentRunRow => {
  const r = freezeAgentRun(record, importedAt);
  return {
    id: asAgentRunId(r.id), session_id: asSessionId(r.sessionId),
    parent_turn_id: asTurnId(r.parentTurnId),
    parent_agent_run_id: r.parentAgentRunId ? asAgentRunId(r.parentAgentRunId) : null,
    task_id: r.taskId ? asTaskId(r.taskId) : null, kind: r.kind,
    purpose: r.purpose, provider_config_id: r.providerConfigId, model_id: r.modelId,
    status: r.status, error: r.error, iterations: r.iterations,
    tool_call_count: r.toolCallCount, input_tokens: r.inputTokens,
    output_tokens: r.outputTokens, output_excerpt: r.outputExcerpt, version: r.version,
    created_at: r.createdAt, updated_at: r.updatedAt, completed_at: r.completedAt,
  };
};

export const restoreAgentRunMessage = (r: AgentRunMessageRecord): AgentRunMessageRow => ({
  id: r.id, agent_run_id: asAgentRunId(r.agentRunId), role: r.role, content_json: r.contentJson,
  sequence: r.sequence, created_at: r.createdAt,
});

export const restoreToolExecution = (
  record: ToolExecutionRecord,
  importedAt: number,
): SessionBackupToolExecutionRow => {
  const r = freezeToolExecution(record, importedAt);
  return {
    call_id: r.callId, session_id: r.sessionId, turn_id: r.turnId,
    agent_run_id: r.agentRunId, tool_name: r.toolName, status: r.status, started_at: r.startedAt,
    completed_at: r.completedAt, version: r.version, created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
};

export const restoreBackgroundProcess = (
  record: BackgroundProcessRecord,
  outputRelativePath: string,
  importedAt: number,
): BackgroundProcessRow => {
  const r = freezeBackgroundProcess(record, importedAt);
  return {
    id: r.id as BackgroundProcessRow['id'],
    session_id: r.sessionId as BackgroundProcessRow['session_id'],
    origin_turn_id: r.originTurnId as BackgroundProcessRow['origin_turn_id'],
    tool_call_id: r.toolCallId as BackgroundProcessRow['tool_call_id'],
    command: r.command, description: r.description, cwd: r.cwd, status: r.status,
    timeout_ms: r.timeoutMs, version: r.version, created_at: r.createdAt,
    started_at: r.startedAt, completed_at: r.completedAt, exit_code: r.exitCode,
    termination_reason: r.terminationReason, stdout_bytes: r.stdoutBytes,
    stderr_bytes: r.stderrBytes, output_truncated: r.outputTruncated ? 1 : 0,
    output_relative_path: outputRelativePath, completion_claimed_at: r.completionClaimedAt,
    continuation_turn_id: r.continuationTurnId as BackgroundProcessRow['continuation_turn_id'],
    model_notified_at: r.modelNotifiedAt,
  };
};

export const restoreUsage = (r: UsageRecord): UsageRecordRow => ({
  id: r.id, session_id: r.sessionId, turn_id: r.turnId, provider_id: r.providerId,
  model_id: r.modelId, capability: r.capability, status: r.status,
  input_tokens: r.inputTokens, output_tokens: r.outputTokens,
  cache_read_input_tokens: r.cacheReadInputTokens,
  cache_write_input_tokens: r.cacheWriteInputTokens, quantity: r.quantity, unit: r.unit,
  duration_ms: r.durationMs, error_code: r.errorCode,
  created_at: r.createdAt,
});

export const restoreKbActivation = (r: KbActivationRecord): KbActivationRow => ({
  id: r.id, call_id: r.callId, kb_id: r.kbId, asset_id: r.assetId,
  session_id: r.sessionId, turn_id: r.turnId, created_at: r.createdAt,
});
