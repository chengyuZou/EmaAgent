// 验证当前 Session 记录协议接受现行字段并拒绝旧备份字段.
import { describe, expect, it } from 'vitest';
import type { TurnRow } from '@ema-agent/storage';
import { toSessionRecord, toTurnRecord } from '../records/exportMappings.js';
import { restoreSessionRecord, restoreTurnRecord } from '../records/importMappings.js';
import { sessionRecordSchema, turnRecordSchema } from '../records/sessionRecords.js';

const currentSession = {
  id: 'session-1',
  title: '示例',
  cwd: 'D:/work',
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
  reasoningEffort: 'off',
  permissionMode: 'default',
  ttsEnabled: false,
} as const;

describe('session records', () => {
  it('接受当前 Session 结构', () => {
    const parsed = sessionRecordSchema.parse(currentSession);
    expect(parsed.id).toBe('session-1');
    expect(parsed).not.toHaveProperty('sessionMode');
    expect(restoreSessionRecord(parsed)).not.toHaveProperty('session_mode');
  });

  it('Plan 权限在导出, 协议校验和恢复映射中原样保留', () => {
    const record = sessionRecordSchema.parse({ ...currentSession, permissionMode: 'plan' });
    const row = restoreSessionRecord(record);
    expect(row.permission_mode).toBe('plan');
    expect(toSessionRecord(row)).toEqual(record);
  });

  it('拒绝旧协议遗留字段', () => {
    expect(() => sessionRecordSchema.parse({ ...currentSession, provider_config_id: 'old' }))
      .toThrow();
    expect(() => sessionRecordSchema.parse({ ...currentSession, sessionMode: 'work' }))
      .toThrow();
  });

  it('Turn 记录 protocol 往返（导出 → 校验 → 恢复）', () => {
    const turnRow = {
      id: 'turn-1',
      session_id: 'session-1',
      status: 'completed',
      trigger_type: 'userMessage',
      tts_enabled: 1,
      provider_id: 'openai',
      model_id: 'gpt-5.2',
      protocol: 'openai-responses-llm',
      character_name: 'ema',
      iterations: 3,
      created_at: 1,
      completed_at: 2,
      error_code: null,
      error_message: null,
    } as unknown as TurnRow;

    const record = toTurnRecord(turnRow);
    const parsed = turnRecordSchema.parse(record);
    expect(record).not.toHaveProperty('sessionMode');
    expect(parsed.protocol).toBe('openai-responses-llm');
    expect(parsed.ttsEnabled).toBe(true);
    expect(parsed.characterName).toBe('ema');
    const restored = restoreTurnRecord(parsed, 3);
    expect(restored.protocol).toBe('openai-responses-llm');
    expect(restored.tts_enabled).toBe(1);
    expect(restored.character_name).toBe('ema');
    expect(restored).not.toHaveProperty('session_mode');
    expect(() => turnRecordSchema.parse({ ...record, sessionMode: 'chat' })).toThrow();
  });

  it('拒绝缺失 protocol 键的旧 Turn 记录（开发期不兼容）', () => {
    expect(() => turnRecordSchema.parse({
      id: 'turn-1',
      sessionId: 'session-1',
      status: 'completed',
      triggerType: 'userMessage',
      providerId: 'openai',
      modelId: 'gpt-5.2',
      characterName: null,
      iterations: 3,
      createdAt: 1,
      completedAt: 2,
      errorCode: null,
      errorMessage: null,
    })).toThrow();
  });
});
