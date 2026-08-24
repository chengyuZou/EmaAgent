// 验证当前 Session 记录协议接受现行字段并拒绝旧备份字段。
import { describe, expect, it } from 'vitest';
import type { TurnRow } from '@ema-agent/storage';
import { toTurnRecord } from '../records/exportMappings.js';
import { restoreTurnRecord } from '../records/importMappings.js';
import { sessionRecordSchema, turnRecordSchema } from '../records/sessionRecords.js';

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

  it('Turn 记录 protocol 往返（导出 → 校验 → 恢复）', () => {
    const turnRow = {
      id: 'turn-1',
      session_id: 'session-1',
      status: 'completed',
      trigger_type: 'userMessage',
      execution_profile: 'work',
      narrative_policy: 'auto',
      provider_id: 'openai',
      model_id: 'gpt-5.2',
      protocol: 'openai-responses-llm',
      character_directory_name: null,
      iterations: 3,
      usage_input_tokens: 10,
      usage_output_tokens: 5,
      created_at: 1,
      completed_at: 2,
      error_code: null,
      error_message: null,
    } as unknown as TurnRow;

    const record = toTurnRecord(turnRow);
    const parsed = turnRecordSchema.parse(record);
    expect(parsed.protocol).toBe('openai-responses-llm');
    expect(restoreTurnRecord(parsed, 3).protocol).toBe('openai-responses-llm');
  });

  it('拒绝缺失 protocol 键的旧 Turn 记录（开发期不兼容）', () => {
    expect(() => turnRecordSchema.parse({
      id: 'turn-1',
      sessionId: 'session-1',
      status: 'completed',
      triggerType: 'userMessage',
      executionProfile: 'work',
      narrativePolicy: 'auto',
      providerId: 'openai',
      modelId: 'gpt-5.2',
      characterDirectoryName: null,
      iterations: 3,
      usageInputTokens: 10,
      usageOutputTokens: 5,
      createdAt: 1,
      completedAt: 2,
      errorCode: null,
      errorMessage: null,
    })).toThrow();
  });
});
