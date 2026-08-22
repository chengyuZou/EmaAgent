// 验证当前 Session 记录协议接受现行字段并拒绝旧备份字段。
import { describe, expect, it } from 'vitest';
import { sessionRecordSchema } from '../records/sessionRecords.js';

const currentSession = {
  id: 'session-1',
  title: '示例',
  workspaceRoot: null,
  projectId: null,
  pinned: false,
  archivedAt: null,
  forkedFromSessionId: null,
  forkedFromTurnId: null,
  lastViewedAt: null,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1,
  providerId: null,
  modelId: null,
  executionProfile: 'work',
  narrativePolicy: 'auto',
} as const;

describe('session records', () => {
  it('接受当前 Session 结构', () => {
    expect(sessionRecordSchema.parse(currentSession).id).toBe('session-1');
  });

  it('拒绝旧协议遗留字段', () => {
    expect(() => sessionRecordSchema.parse({ ...currentSession, provider_config_id: 'old' }))
      .toThrow();
  });
});
