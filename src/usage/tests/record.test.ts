// 验证 reportUsage 的校验拒绝、写入失败转交与默认诊断行为。
import { describe, expect, it, vi } from 'vitest';
import { createUsageRecord, reportUsage } from '../record.js';
import { UsageRecordValidationError } from '../errors.js';
import type { UsageRecord, UsageRecorder } from '../types.js';

function collectRecorder(): { recorder: UsageRecorder; records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  return {
    records,
    recorder: { record: (record) => records.push(record) },
  };
}

function validRecord(): UsageRecord {
  return createUsageRecord({
    capability: 'llm',
    providerId: 'provider-1',
    modelId: 'model-1',
    status: 'completed',
    startedAt: 1_000,
    durationMs: 50,
    usageContext: { callId: 'call-1', sessionId: 'session-1', turnId: 'turn-1' },
    inputTokens: 10,
    outputTokens: 5,
  });
}

describe('reportUsage', () => {
  it('合法记录写入 recorder', () => {
    const { recorder, records } = collectRecorder();
    const record = validRecord();
    reportUsage(recorder, record);
    expect(records).toEqual([record]);
  });

  it('非法记录不写库，并转交 UsageRecordValidationError', () => {
    const { recorder, records } = collectRecorder();
    const record = createUsageRecord({
      capability: 'llm',
      providerId: 'provider-1',
      modelId: 'model-1',
      status: 'completed',
      startedAt: 1_000,
      durationMs: Number.NaN,
      usageContext: { callId: 'call-1', sessionId: 'session-1', turnId: 'turn-1' },
    });
    const onError = vi.fn();

    reportUsage(recorder, record, onError);

    expect(records).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(UsageRecordValidationError);
    expect(onError.mock.calls[0]![1]).toBe(record);
  });

  it('未提供 onError 时打印默认诊断，仍不写库', () => {
    const { recorder, records } = collectRecorder();
    const record = createUsageRecord({
      capability: 'llm',
      providerId: 'provider-1',
      modelId: 'model-1',
      status: 'completed',
      startedAt: 1_000,
      durationMs: Number.NaN,
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportUsage(recorder, record);
      expect(records).toHaveLength(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('recorder 抛错时转交 onError，且不向调用方抛出', () => {
    const recorder: UsageRecorder = {
      record: () => { throw new Error('db down'); },
    };
    const onError = vi.fn();
    const record = validRecord();

    expect(() => reportUsage(recorder, record, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), record);
  });

  it('onError 自身抛错被吞掉，不破坏调用方', () => {
    const { recorder } = collectRecorder();
    const record = validRecord();

    expect(() => reportUsage(recorder, record, () => { throw new Error('boom'); }))
      .not.toThrow();
  });
});
