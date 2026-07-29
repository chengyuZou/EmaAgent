// 测试调用级用量记录可在同一 Turn 下共存，并保持确定性查询顺序。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/ids';
import type { UsageRecord } from '@ema-agent/usage';
import { UsageRecordsRepo } from '../../repos/usage-records.js';
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
        (id, session_id, trigger_type, execution_profile, narrative_policy, status, user_input, started_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'off', 'completed', 'test', 1)
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
    costUsd: null, durationMs: 100, errorCode: null, createdAt,
  });

  it('同一 Turn 的多次调用不会互相覆盖', () => {
    expect(database.db.pragma('user_version', { simple: true })).toBe(23);
    repo.record(record('call-b', 10));
    repo.record(record('call-a', 10));
    expect(repo.forTurn(asTurnId('turn-a')).map((row) => row.id)).toEqual(['call-a', 'call-b']);
    expect(repo.forSession(asSessionId('session-a'))).toHaveLength(2);
  });

  it('重复上报同一调用不会制造重复账单', () => {
    repo.record(record('call-a', 10));
    repo.record({ ...record('call-a', 20), outputTokens: 999 });
    expect(repo.forTurn(asTurnId('turn-a'))).toEqual([
      expect.objectContaining({ id: 'call-a', output_tokens: 20, created_at: 10 }),
    ]);
  });

  it('同一逻辑调用重试成功后可把失败终态提升为完成', () => {
    repo.record({ ...record('call-retry', 10), status: 'failed', errorCode: 'llm/context_too_large' });
    repo.record({ ...record('call-retry', 20), status: 'completed', outputTokens: 30 });

    expect(repo.forTurn(asTurnId('turn-a'))).toEqual([
      expect.objectContaining({
        id: 'call-retry', status: 'completed', output_tokens: 30, error_code: null, created_at: 20,
      }),
    ]);
  });

  it('保存取消终态，且迟到完成不得覆盖已经确认的取消', () => {
    repo.record({
      ...record('call-cancelled', 10),
      status: 'cancelled',
      errorCode: 'llm/aborted',
    });
    repo.record({
      ...record('call-cancelled', 20),
      status: 'completed',
      outputTokens: 30,
    });

    expect(repo.forTurn(asTurnId('turn-a'))).toEqual([
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
