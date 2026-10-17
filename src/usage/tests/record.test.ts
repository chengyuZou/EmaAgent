import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database, SessionsRepo } from '@ema-agent/storage';
import { UsageRecorder } from '../record.js';
import type { UsageRecord } from '../types.js';

let database: Database;
let recorder: UsageRecorder;

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  new SessionsRepo(database.sqlite).insert({
    id: 'session-1', title: 'Session', cwd: '', createdAt: 1, updatedAt: 1,
  });
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, status, created_at)
    VALUES ('turn-1', 'session-1', 'userMessage', 'completed', 1)
  `).run();
  recorder = new UsageRecorder(database);
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

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
    cacheReadInputTokens: 4,
    cacheWriteInputTokens: null,
    quantity: null,
    unit: null,
    durationMs: 50,
    errorCode: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('UsageRecorder', () => {
  it('将业务字段写入 SQL, 查询时恢复为相同业务记录', () => {
    const input = record();
    recorder.record(input);
    expect(recorder.forTurn('turn-1')).toEqual([input]);
    expect(database.sqlite.prepare('SELECT * FROM usage_records').get()).toMatchObject({
      id: input.id,
      session_id: input.sessionId,
      turn_id: input.turnId,
      input_tokens: 10,
      cache_read_input_tokens: 4,
      duration_ms: 50,
      created_at: 1_000,
    });
  });

  it.each(['failed', 'cancelled'] as const)('保存 %s 的已报告用量与未知量 null', status => {
    const input = record({ status, outputTokens: null, errorCode: 'provider/failed' });
    recorder.record(input);
    expect(recorder.forTurn('turn-1')).toEqual([input]);
  });

  it('保存无 Session 的后台调用与非 Token 用量', () => {
    const input = record({
      sessionId: null,
      turnId: null,
      capability: 'tts',
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      quantity: 12,
      unit: 'character',
    });
    recorder.record(input);
    expect(recorder.list({ capability: 'tts' }).items).toEqual([input]);
    expect(recorder.forTurn('turn-1')).toEqual([]);
  });

  it('按时间和 ID 分页, 同时按 Session 与能力筛选', () => {
    const a = record({ id: 'a' });
    const b = record({ id: 'b' });
    recorder.record(a);
    recorder.record(b);
    recorder.record(record({ id: 'tts', capability: 'tts' }));
    recorder.record(record({ id: 'background', sessionId: null, turnId: null }));
    const first = recorder.list({ sessionId: 'session-1', capability: 'llm', limit: 1 });
    expect(first.items).toEqual([b]);
    expect(first.nextCursor).toEqual({ createdAt: 1_000, id: 'b' });
    const second = recorder.list({
      sessionId: 'session-1', capability: 'llm', limit: 1, cursor: first.nextCursor!,
    });
    expect(second).toEqual({ items: [a], nextCursor: null });
    expect(recorder.forTurn('turn-1').map(item => item.id)).toEqual(['a', 'b', 'tts']);
  });

  it('重复 ID 写入只告警, 不覆盖原记录或向模型调用方抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = record();
    recorder.record(input);
    expect(() => recorder.record({ ...input, outputTokens: 999 })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(recorder.forTurn('turn-1')).toEqual([input]);
  });

  it('SQL 拒绝的记录只告警, 不写入也不影响调用结果', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recorder.record(record({ outputTokens: -1 }))).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(recorder.list({}).items).toEqual([]);
  });

  it('查询错误向上抛出, 不伪装成空列表', () => {
    vi.spyOn(database.sqlite, 'prepare').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    expect(() => recorder.list({})).toThrow('database unavailable');
    expect(() => recorder.forTurn('turn-1')).toThrow('database unavailable');
  });
});
