// 测试调用级用量记录可在同一 Turn 下共存，并保持确定性查询顺序。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '@ema-agent/usage';
import { UsageRecordsRepo } from '../../repos/data/usage-records.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('UsageRecordsRepo', () => {
  let database: TestDatabase;
  let repo: UsageRecordsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, trigger_type, execution_profile, narrative_policy, status, created_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'off', 'completed', 1)
    `).run();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-b', 'Session B', 1, 1)
    `).run();
    repo = new UsageRecordsRepo(database.db);
  });

  afterEach(() => database.close());

  const record = (id: string, createdAt: number): UsageRecord => ({
    id, sessionId: 'session-a', turnId: 'turn-a', providerId: 'provider-a', modelId: 'model-a',
    capability: 'llm', status: 'completed', inputTokens: 10, outputTokens: 20,
    cacheReadInputTokens: null, cacheWriteInputTokens: null, quantity: null, unit: null,
    durationMs: 100, errorCode: null, createdAt,
  });

  it('同一 Turn 的多次调用不会互相覆盖', () => {
    expect(database.db.pragma('user_version', { simple: true })).toBe(1);
    repo.record(record('call-b', 10));
    repo.record(record('call-a', 10));
    expect(repo.forTurn('turn-a').map((row) => row.id)).toEqual(['call-a', 'call-b']);
    expect(repo.forSession('session-a')).toHaveLength(2);
  });

  it('重复物理调用身份由唯一键暴露为实现错误', () => {
    repo.record(record('call-a', 10));
    expect(() => repo.record({ ...record('call-a', 20), outputTokens: 999 }))
      .toThrow(/UNIQUE constraint failed/);
  });

  it('失败重试是两次物理调用，分别保留各自终态', () => {
    repo.record({ ...record('call-failed', 10), status: 'failed', errorCode: 'llm/context_too_large' });
    repo.record({ ...record('call-retry', 20), status: 'completed', outputTokens: 30 });

    expect(repo.forTurn('turn-a')).toEqual([
      expect.objectContaining({
        id: 'call-failed', status: 'failed', error_code: 'llm/context_too_large', created_at: 10,
      }),
      expect.objectContaining({
        id: 'call-retry', status: 'completed', output_tokens: 30, error_code: null, created_at: 20,
      }),
    ]);
  });

  it('保存取消终态', () => {
    repo.record({
      ...record('call-cancelled', 10),
      status: 'cancelled',
      errorCode: 'llm/aborted',
    });

    expect(repo.forTurn('turn-a')).toEqual([
      expect.objectContaining({
        id: 'call-cancelled',
        status: 'cancelled',
        output_tokens: 20,
        error_code: 'llm/aborted',
        created_at: 10,
      }),
    ]);
  });

  it('数据库约束拒绝未知 Usage 终态', () => {
    expect(() => database.db.prepare(`
      INSERT INTO usage_records (
        id, provider_id, model_id, capability, status,
        duration_ms, created_at
      ) VALUES ('invalid-status', 'provider-a', 'model-a', 'llm', 'aborted', 1, 1)
    `).run()).toThrow(/CHECK constraint failed/);
  });

  it('拒绝把 Turn 用量归到另一个 Session', () => {
    expect(() => repo.record({ ...record('cross-session', 10), sessionId: 'session-b' }))
      .toThrow(/ownership_violation/);
  });
});
