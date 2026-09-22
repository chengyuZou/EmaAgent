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
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, trigger_type, session_mode, narrative_policy, status, created_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'off', 'completed', 1)
    `).run();
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-b', 'Session B', 'D:/work', 1, 1)
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
    expect(database.db.pragma('user_version', { simple: true })).toBe(2);
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


  it('list: sessionId/capability 过滤 + keyset 翻页不重复不遗漏', () => {
    // 同刻三条(决胜 id)+ 异刻两条 + 别的 session + 别的 capability
    repo.record({ ...record('r-3', 100), id: 'r-c' });
    repo.record({ ...record('r-2', 100), id: 'r-b' });
    repo.record({ ...record('r-1', 100), id: 'r-a' });
    repo.record(record('r-old', 50));
    repo.record({ ...record('r-other-session', 90), sessionId: 'session-b', turnId: null });
    repo.record({ ...record('r-tts', 95), capability: 'tts', inputTokens: null, outputTokens: null });

    // 第一页:倒序最新 3 条(同刻按 id 倒序 r-c > r-b > r-a)
    const page1 = repo.list({ sessionId: 'session-a', limit: 3 });
    expect(page1.items.map(row => row.id)).toEqual(['r-c', 'r-b', 'r-a']);
    expect(page1.nextCursor).not.toBeNull();

    // 第二页:游标后继续,不重复不遗漏(r-tts 95, r-old 50)
    const page2 = repo.list({ sessionId: 'session-a', limit: 3, cursor: page1.nextCursor! });
    expect(page2.items.map(row => row.id)).toEqual(['r-tts', 'r-old']);
    expect(page2.nextCursor).toBeNull();

    // capability 过滤
    const tts = repo.list({ sessionId: 'session-a', capability: 'tts' });
    expect(tts.items.map(row => row.id)).toEqual(['r-tts']);

    // 不传 sessionId = 整库
    const all = repo.list({ limit: 10 });
    expect(all.items).toHaveLength(6);
  });

});
