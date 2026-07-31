// 备份记录的逐条结构校验与小集合图检查:枚举、必填身份与 Task 依赖图。
// 跨记录引用与唯一性由批二导入流水线用落盘索引完成,不在内存全量数组上执行。
import type {
  AgentRunRecord,
  SessionRecord,
  TaskDependencyRecord,
  UsageRecord,
} from './sessionRecords.js';

export interface RecordValidationIssue {
  readonly scope: string;
  readonly message: string;
}

const PROFILES = new Set(['chat', 'work']);
const POLICIES = new Set(['auto', 'always', 'off']);
const TRIGGERS = new Set(['userMessage', 'backgroundProcessCompleted']);
const TURN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'aborted']);
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const MESSAGE_KINDS = new Set(['normal', 'tool_results', 'summary', 'narrative_context']);
const TOOL_STATUSES = new Set([
  'prepared', 'authorized', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown',
]);
const PROCESS_STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'timedOut', 'stopped', 'interrupted',
]);

/** Session 头校验:枚举、自引用与模型偏好成对。 */
export function validateSessionRecord(session: SessionRecord): RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  const push = (message: string): void => { issues.push({ scope: 'session', message }); };

  if (!session.id) push('Session id 不能为空');
  if (!PROFILES.has(session.executionProfile)) push(`executionProfile 非法: ${session.executionProfile}`);
  if (!POLICIES.has(session.narrativePolicy)) push(`narrativePolicy 非法: ${session.narrativePolicy}`);
  if (session.parentSessionId === session.id) push('Session 不能把自身设为 parentSessionId');
  const hasProvider = session.preferredProviderConfigId !== null;
  const hasModel = session.preferredModelId !== null;
  if (hasProvider !== hasModel) push('模型偏好必须同时包含供应商配置和模型');
  if (hasProvider && (!session.preferredProviderConfigId?.trim() || !session.preferredModelId?.trim())) {
    push('模型偏好不能为空字符串');
  }
  return issues;
}

export function validateTurnEnums(turn: {
  id: string;
  triggerType: string;
  executionProfile: string;
  narrativePolicy: string;
  status: string;
}): RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  if (!TRIGGERS.has(turn.triggerType)) issues.push({ scope: 'Turn', message: `triggerType 非法: ${turn.id}` });
  if (!PROFILES.has(turn.executionProfile)) issues.push({ scope: 'Turn', message: `executionProfile 非法: ${turn.id}` });
  if (!POLICIES.has(turn.narrativePolicy)) issues.push({ scope: 'Turn', message: `narrativePolicy 非法: ${turn.id}` });
  if (!TURN_STATUSES.has(turn.status)) issues.push({ scope: 'Turn', message: `status 非法: ${turn.id}` });
  return issues;
}

export function validateMessageEnums(message: {
  id: string;
  role: string;
  kind: string;
}): RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  if (!MESSAGE_ROLES.has(message.role)) issues.push({ scope: 'Message', message: `role 非法: ${message.id}` });
  if (!MESSAGE_KINDS.has(message.kind)) issues.push({ scope: 'Message', message: `kind 非法: ${message.id}` });
  return issues;
}

export function validateToolExecutionEnums(execution: {
  callId: string;
  status: string;
}): RecordValidationIssue[] {
  return TOOL_STATUSES.has(execution.status)
    ? []
    : [{ scope: 'ToolExecution', message: `status 非法: ${execution.callId}` }];
}

export function validateBackgroundProcessEnums(process: {
  id: string;
  status: string;
}): RecordValidationIssue[] {
  return PROCESS_STATUSES.has(process.status)
    ? []
    : [{ scope: 'BackgroundProcess', message: `status 非法: ${process.id}` }];
}

/** 单 Session 备份不允许 sessionId=null 的全局 Usage 记录混入。 */
export function validateUsageRecordScope(record: UsageRecord): RecordValidationIssue[] {
  return record.sessionId === null
    ? [{ scope: 'UsageRecord', message: `全局用量记录不属于单 Session 备份: ${record.id}` }]
    : [];
}

/** 父子 AgentRun 链接:父 Run 必须存在且与子 Run 属于同一 parentTurnId。O(n) Map,不递归。 */
export function validateAgentRunLinks(runs: readonly AgentRunRecord[]): RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  const byId = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) {
    if (run.parentAgentRunId === null) continue;
    const parent = byId.get(run.parentAgentRunId);
    if (!parent) {
      issues.push({ scope: 'AgentRun', message: `父 AgentRun 不存在: ${run.id} -> ${run.parentAgentRunId}` });
      continue;
    }
    if (parent.parentTurnId !== run.parentTurnId) {
      issues.push({ scope: 'AgentRun', message: `父子 AgentRun 的 parentTurnId 不一致: ${run.id}` });
    }
  }
  return issues;
}

/** Task 依赖图:迭代式 Kahn 拓扑排序查环,同时拒绝重复边;深链不爆栈。 */
export function checkTaskDependencyGraph(
  dependencies: readonly TaskDependencyRecord[],
): RecordValidationIssue[] {
  const issues: RecordValidationIssue[] = [];
  const downstream = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const seenEdges = new Set<string>();

  for (const dependency of dependencies) {
    const edgeKey = `${dependency.blockerTaskId}->${dependency.blockedTaskId}`;
    if (seenEdges.has(edgeKey)) {
      issues.push({ scope: 'TaskDependency', message: `重复依赖边: ${edgeKey}` });
      continue;
    }
    seenEdges.add(edgeKey);
    if (dependency.blockerTaskId === dependency.blockedTaskId) {
      issues.push({ scope: 'TaskDependency', message: `Task 不能依赖自身: ${dependency.blockerTaskId}` });
      continue;
    }
    const next = downstream.get(dependency.blockerTaskId) ?? [];
    next.push(dependency.blockedTaskId);
    downstream.set(dependency.blockerTaskId, next);
    indegree.set(dependency.blockedTaskId, (indegree.get(dependency.blockedTaskId) ?? 0) + 1);
    indegree.set(dependency.blockerTaskId, indegree.get(dependency.blockerTaskId) ?? 0);
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    visited += 1;
    for (const childId of downstream.get(current) ?? []) {
      const degree = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, degree);
      if (degree === 0) queue.push(childId);
    }
  }
  if (visited < indegree.size) {
    issues.push({ scope: 'TaskDependency', message: '依赖图存在循环' });
  }
  return issues;
}
