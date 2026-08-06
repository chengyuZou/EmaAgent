// 验证 validateUsageRecord 对用量记录各非法形态的判定。
import { describe, expect, it } from 'vitest';
import { validateUsageRecord } from '../validate.js';
import type { UsageRecord } from '../types.js';

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    capability: 'llm',
    status: 'completed',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    quantity: null,
    unit: null,
    durationMs: 100,
    errorCode: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('validateUsageRecord', () => {
  it('接受合法记录', () => {
    expect(validateUsageRecord(record())).toHaveLength(0);
  });

  it('接受仅带 callId 的后台调用记录', () => {
    const r = record({ sessionId: null, turnId: null });
    expect(validateUsageRecord(r)).toHaveLength(0);
  });

  it('拒绝空 id / providerId / modelId', () => {
    expect(validateUsageRecord(record({ id: ' ' }))).toContainEqual(
      expect.objectContaining({ field: 'id', code: 'empty' }),
    );
    expect(validateUsageRecord(record({ providerId: '' }))).toContainEqual(
      expect.objectContaining({ field: 'providerId', code: 'empty' }),
    );
    expect(validateUsageRecord(record({ modelId: '' }))).toContainEqual(
      expect.objectContaining({ field: 'modelId', code: 'empty' }),
    );
  });

  it('拒绝 NaN / Infinity 数值字段', () => {
    expect(validateUsageRecord(record({ durationMs: Number.NaN }))).toContainEqual(
      expect.objectContaining({ field: 'durationMs', code: 'not_finite' }),
    );
    expect(validateUsageRecord(record({ createdAt: Number.POSITIVE_INFINITY }))).toContainEqual(
      expect.objectContaining({ field: 'createdAt', code: 'not_finite' }),
    );
    expect(validateUsageRecord(record({ inputTokens: Number.NaN }))).toContainEqual(
      expect.objectContaining({ field: 'inputTokens', code: 'not_finite' }),
    );
  });

  it('拒绝负数 token / quantity / durationMs', () => {
    expect(validateUsageRecord(record({ outputTokens: -1 }))).toContainEqual(
      expect.objectContaining({ field: 'outputTokens', code: 'negative' }),
    );
    expect(validateUsageRecord(record({ quantity: -3, unit: 'text' }))).toContainEqual(
      expect.objectContaining({ field: 'quantity', code: 'negative' }),
    );
    expect(validateUsageRecord(record({ durationMs: -5 }))).toContainEqual(
      expect.objectContaining({ field: 'durationMs', code: 'negative' }),
    );
  });

  it('拒绝 quantity / unit 不成对', () => {
    expect(validateUsageRecord(record({ quantity: 3, unit: null }))).toContainEqual(
      expect.objectContaining({ field: 'unit', code: 'quantity_unit_mismatch' }),
    );
    expect(validateUsageRecord(record({ quantity: null, unit: 'text' }))).toContainEqual(
      expect.objectContaining({ field: 'quantity', code: 'quantity_unit_mismatch' }),
    );
  });

  it('拒绝 completed 携带 errorCode，接受 failed 携带 errorCode', () => {
    expect(validateUsageRecord(record({ errorCode: 'llm/aborted' }))).toContainEqual(
      expect.objectContaining({ field: 'errorCode', code: 'completed_with_error' }),
    );
    expect(validateUsageRecord(record({
      status: 'failed',
      errorCode: 'provider/down',
    }))).toHaveLength(0);
  });

  it('拒绝 turnId 存在但 sessionId 为空', () => {
    expect(validateUsageRecord(record({ sessionId: null }))).toContainEqual(
      expect.objectContaining({ field: 'sessionId', code: 'turn_without_session' }),
    );
  });

  it('拒绝未知 capability / status', () => {
    expect(validateUsageRecord(record({ capability: 'chat' as never }))).toContainEqual(
      expect.objectContaining({ field: 'capability', code: 'unknown' }),
    );
    expect(validateUsageRecord(record({ status: 'aborted' as never }))).toContainEqual(
      expect.objectContaining({ field: 'status', code: 'unknown' }),
    );
  });

  it('一次性收集全部问题', () => {
    const issues = validateUsageRecord(record({
      id: '',
      inputTokens: -1,
      quantity: 3,
      unit: null,
      errorCode: 'boom',
    }));
    expect(issues.map((issue) => `${issue.field}.${issue.code}`)).toEqual([
      'id.empty',
      'errorCode.completed_with_error',
      'inputTokens.negative',
      'unit.quantity_unit_mismatch',
    ]);
  });
});
