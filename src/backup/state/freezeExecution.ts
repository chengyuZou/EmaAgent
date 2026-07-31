// 将来源机未完成的执行状态冻结为安全终态，导入后绝不自动恢复或重放副作用。
import type {
  AgentRunRecord,
  BackgroundProcessRecord,
  TaskRecord,
  ToolExecutionRecord,
  TurnRecord,
} from '../records/sessionRecords.js';

export function freezeTurn(record: TurnRecord, importedAt: number): TurnRecord {
  if (record.status !== 'pending' && record.status !== 'running') return record;
  return {
    ...record,
    status: 'aborted',
    completedAt: record.completedAt ?? importedAt,
    errorCode: 'backup/import_interrupted',
    errorMessage: 'Turn was unfinished when the Session backup was imported',
  };
}

export function freezeTask(record: TaskRecord): TaskRecord {
  return record.status === 'in_progress'
    ? { ...record, status: 'pending', version: record.version + 1 }
    : record;
}

export function freezeAgentRun(record: AgentRunRecord, importedAt: number): AgentRunRecord {
  if (record.status !== 'running') return record;
  return {
    ...record,
    status: 'cancelled',
    error: 'Agent run was unfinished when the Session backup was imported',
    completedAt: record.completedAt ?? importedAt,
    version: record.version + 1,
  };
}

export function freezeToolExecution(
  record: ToolExecutionRecord,
  importedAt: number,
): ToolExecutionRecord {
  if (!['prepared', 'authorized', 'running'].includes(record.status)) return record;
  const wasRunning = record.status === 'running';
  return {
    ...record,
    status: wasRunning ? 'outcome_unknown' : 'cancelled',
    errorCode: wasRunning ? 'tool/outcome_unknown' : 'tool/process_interrupted',
    errorMessage: 'Tool execution was unfinished when the Session backup was imported',
    completedAt: record.completedAt ?? importedAt,
    version: record.version + 1,
    updatedAt: Math.max(record.updatedAt, importedAt),
  };
}

export function freezeBackgroundProcess(
  record: BackgroundProcessRecord,
  importedAt: number,
): BackgroundProcessRecord {
  if (record.status !== 'queued' && record.status !== 'running') return record;
  return {
    ...record,
    status: 'interrupted',
    completedAt: record.completedAt ?? importedAt,
    terminationReason: 'Process was unfinished when the Session backup was imported',
    completionClaimedAt: null,
    continuationTurnId: null,
    modelNotifiedAt: null,
    version: record.version + 1,
  };
}
