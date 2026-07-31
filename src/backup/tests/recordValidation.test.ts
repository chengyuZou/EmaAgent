// 测试逐条结构校验与图检查:枚举、模型偏好、父子链接、依赖环与重复边。
import { describe, expect, it } from 'vitest';
import {
  checkTaskDependencyGraph,
  validateAgentRunLinks,
  validateBackgroundProcessEnums,
  validateMessageEnums,
  validateSessionRecord,
  validateToolExecutionEnums,
  validateTurnEnums,
  validateUsageRecordScope,
} from '../records/recordValidation.js';
import type { AgentRunRecord, SessionRecord, UsageRecord } from '../records/sessionRecords.js';

function session(): SessionRecord {
  return {
    id: 's1', title: '测试', sourceWorkspaceRoot: null,
    createdAt: 1, updatedAt: 2, lastActivityAt: 2,
    archivedAt: null, pinned: false, pinnedAt: null,
    groupLabel: null, parentSessionId: null,
    executionProfile: 'chat', narrativePolicy: 'auto',
    preferredProviderConfigId: null, preferredModelId: null,
  };
}

function agentRun(id: string, parentTurnId: string, parentAgentRunId: string | null): AgentRunRecord {
  return {
    id, sessionId: 's1', parentTurnId, parentAgentRunId,
    taskId: null, kind: 'subagent', purpose: null,
    providerConfigId: null, modelId: null,
    status: 'completed', error: null,
    iterations: 1, toolCallCount: 0, inputTokens: 0, outputTokens: 0,
    outputExcerpt: null, version: 1, createdAt: 1, updatedAt: 1, completedAt: 2,
  };
}

describe('validateSessionRecord', () => {
  it('合法 session 通过', () => {
    expect(validateSessionRecord(session())).toEqual([]);
  });

  it('模型偏好必须成对出现', () => {
    const issues = validateSessionRecord({ ...session(), preferredProviderConfigId: 'p1' });
    expect(issues.some((i) => i.message.includes('成对') || i.message.includes('同时'))).toBe(true);
  });

  it('parentSessionId 不能是自身', () => {
    const issues = validateSessionRecord({ ...session(), parentSessionId: 's1' });
    expect(issues.some((i) => i.message.includes('自身'))).toBe(true);
  });
});

describe('枚举校验', () => {
  it('Turn:trigger 白名单对齐 v25,其他值拒绝', () => {
    const base = { id: 't1', triggerType: 'backgroundProcessCompleted', executionProfile: 'chat', narrativePolicy: 'auto', status: 'completed' };
    expect(validateTurnEnums(base)).toEqual([]);
    expect(validateTurnEnums({ ...base, triggerType: 'evil' }).length).toBe(1);
    expect(validateTurnEnums({ ...base, status: 'weird' }).length).toBe(1);
  });

  it('Message:role/kind 数据库枚举', () => {
    const base = { id: 'm1', role: 'user', kind: 'normal' };
    expect(validateMessageEnums(base)).toEqual([]);
    expect(validateMessageEnums({ ...base, role: 'bot' }).length).toBe(1);
    expect(validateMessageEnums({ ...base, kind: 'random' }).length).toBe(1);
  });

  it('ToolExecution:成功终态是 succeeded 不是 completed', () => {
    expect(validateToolExecutionEnums({ callId: 'c1', status: 'succeeded' })).toEqual([]);
    expect(validateToolExecutionEnums({ callId: 'c1', status: 'completed' }).length).toBe(1);
  });

  it('BackgroundProcess:七态全集', () => {
    for (const status of ['queued', 'running', 'completed', 'failed', 'timedOut', 'stopped', 'interrupted']) {
      expect(validateBackgroundProcessEnums({ id: 'bp1', status })).toEqual([]);
    }
    expect(validateBackgroundProcessEnums({ id: 'bp1', status: 'zombie' }).length).toBe(1);
  });
});

describe('validateUsageRecordScope', () => {
  it('sessionId=null 的全局记录拒绝', () => {
    const record = { id: 'u1', sessionId: null } as unknown as UsageRecord;
    expect(validateUsageRecordScope(record).length).toBe(1);
    const scoped = { id: 'u1', sessionId: 's1' } as unknown as UsageRecord;
    expect(validateUsageRecordScope(scoped)).toEqual([]);
  });
});

describe('validateAgentRunLinks', () => {
  it('父子同 parentTurnId 通过', () => {
    const runs = [agentRun('r1', 't1', null), agentRun('r2', 't1', 'r1')];
    expect(validateAgentRunLinks(runs)).toEqual([]);
  });

  it('父 Run 不存在拒绝', () => {
    const runs = [agentRun('r2', 't1', 'ghost')];
    expect(validateAgentRunLinks(runs).some((i) => i.message.includes('不存在'))).toBe(true);
  });

  it('父子 parentTurnId 不一致拒绝', () => {
    const runs = [agentRun('r1', 't1', null), agentRun('r2', 't2', 'r1')];
    expect(validateAgentRunLinks(runs).some((i) => i.message.includes('不一致'))).toBe(true);
  });
});

describe('checkTaskDependencyGraph(Kahn 迭代)', () => {
  const dep = (blocker: string, blocked: string) => ({
    sessionId: 's1', blockerTaskId: blocker, blockedTaskId: blocked, createdAt: 1,
  });

  it('无环通过', () => {
    expect(checkTaskDependencyGraph([dep('a', 'b'), dep('b', 'c')])).toEqual([]);
  });

  it('自环与互环都拒绝', () => {
    expect(checkTaskDependencyGraph([dep('a', 'a')]).some((i) => i.message.includes('自身'))).toBe(true);
    expect(checkTaskDependencyGraph([dep('a', 'b'), dep('b', 'a')]).some((i) => i.message.includes('循环'))).toBe(true);
  });

  it('重复依赖边拒绝', () => {
    expect(checkTaskDependencyGraph([dep('a', 'b'), dep('a', 'b')]).some((i) => i.message.includes('重复'))).toBe(true);
  });

  it('长链不递归不爆栈', () => {
    const chain = Array.from({ length: 50_000 }, (_, i) => dep(`t${i}`, `t${i + 1}`));
    expect(checkTaskDependencyGraph(chain)).toEqual([]);
  });
});
