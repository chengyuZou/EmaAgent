import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageRecordsRepo, type UsageRecordRow } from '../../repos/data/usage-records.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('UsageRecordsRepo', () => {
  let database: TestDatabase;
  let repo: UsageRecordsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1),
             ('session-b', 'Session B', 'D:/work', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns (id, session_id, trigger_type, status, created_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'completed', 1)
    `).run();
    repo = new UsageRecordsRepo(database.db);
  });

  afterEach(() => database.close());

  function record(id: string, createdAt: number): UsageRecordRow {
    return {
      id,
      session_id: 'session-a',
      turn_id: 'turn-a',
      provider_id: 'provider-a',
      model_id: 'model-a',
      capability: 'llm',
      status: 'completed',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: null,
      cache_write_input_tokens: null,
      quantity: null,
      unit: null,
      duration_ms: 100,
      error_code: null,
      created_at: createdAt,
    };
  }

  it('同一 Turn 的多次实际请求不会互相覆盖, 同时按时间和 ID 排序', () => {
    const a = record('call-a', 10);
    const b = record('call-b', 10);
    repo.record(b);
    repo.record(a);
    expect(repo.forTurn('turn-a')).toEqual([a, b]);
    expect(repo.forSession('session-a')).toEqual([a, b]);
  });

  it('只插入请求终态, 重复请求 ID 由 SQL 拒绝且不覆盖原记录', () => {
    const original = record('call-a', 10);
    repo.record(original);
    expect(() => repo.record({ ...original, output_tokens: 999 }))
      .toThrow(/UNIQUE constraint failed/);
    expect(repo.forTurn('turn-a')).toEqual([original]);
  });

  it('失败后的重试保留两个请求各自的终态和用量', () => {
    const failed: UsageRecordRow = {
      ...record('call-failed', 10),
      status: 'failed',
      error_code: 'llm/context_too_large',
    };
    const retry = { ...record('call-retry', 20), output_tokens: 30 };
    repo.record(failed);
    repo.record(retry);
    expect(repo.forTurn('turn-a')).toEqual([failed, retry]);
  });

  it('保存取消后的已知用量和未知量 null', () => {
    const cancelled: UsageRecordRow = {
      ...record('call-cancelled', 10),
      status: 'cancelled',
      output_tokens: null,
      error_code: 'llm/aborted',
    };
    repo.record(cancelled);
    expect(repo.forTurn('turn-a')).toEqual([cancelled]);
  });

  it.each(['running', 'aborted'])('SQL 拒绝非用量终态 %s', status => {
    expect(() => database.db.prepare(`
      INSERT INTO usage_records (
        id, provider_id, model_id, capability, status, duration_ms, created_at
      ) VALUES ('invalid-status', 'provider-a', 'model-a', 'llm', ?, 1, 1)
    `).run(status)).toThrow(/CHECK constraint failed/);
  });

  it('拒绝把 Turn 用量归到另一个 Session', () => {
    expect(() => repo.record({ ...record('cross-session', 10), session_id: 'session-b' }))
      .toThrow(/ownership_violation/);
  });

  it('按 Session 和能力筛选, 同一时间的记录可以稳定翻页', () => {
    repo.record(record('r-c', 100));
    repo.record(record('r-b', 100));
    repo.record(record('r-a', 100));
    repo.record(record('r-old', 50));
    repo.record({
      ...record('r-other-session', 90),
      session_id: 'session-b',
      turn_id: null,
    });
    repo.record({
      ...record('r-tts', 95),
      capability: 'tts',
      input_tokens: null,
      output_tokens: null,
    });

    const first = repo.list({ sessionId: 'session-a', limit: 3 });
    expect(first.items.map(row => row.id)).toEqual(['r-c', 'r-b', 'r-a']);
    expect(first.nextCursor).toEqual({ createdAt: 100, id: 'r-a' });

    const second = repo.list({
      sessionId: 'session-a',
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(second.items.map(row => row.id)).toEqual(['r-tts', 'r-old']);
    expect(second.nextCursor).toBeNull();
    expect(repo.list({ sessionId: 'session-a', capability: 'tts' }).items.map(row => row.id))
      .toEqual(['r-tts']);
    expect(repo.list({ limit: 10 }).items).toHaveLength(6);
  });

  it('保留清理只删除早于截止时间的记录', () => {
    const retained = record('at-cutoff', 20);
    repo.record(record('old', 19));
    repo.record(retained);
    expect(repo.deleteOlderThan(20)).toBe(1);
    expect(repo.forSession('session-a')).toEqual([retained]);
  });
});
