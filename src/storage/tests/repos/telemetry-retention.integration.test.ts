// 测试 Telemetry 的有界保留、清理顺序和迁移索引。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelemetryRepo } from '../../repos/telemetry.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('N-006 Telemetry 有界保留策略', () => {
  let database: TestDatabase;
  let repo: TelemetryRepo;

  beforeEach(() => {
    database = createTestDatabase();
    repo = new TelemetryRepo(database.db);
  });

  afterEach(() => database.close());

  function insert(id: string, kind: string, createdAt: number): void {
    repo.insertEvent({
      id,
      session_id: null,
      turn_id: null,
      kind,
      payload_json: '{}',
      created_at: createdAt,
    });
  }

  it('跨 kind 按 created_at 与 id 顺序分批删除过期事件', () => {
    insert('old-b', 'hook', 10);
    insert('old-a', 'error', 10);
    insert('old-c', 'status', 20);
    insert('boundary', 'error', 30);
    insert('new', 'hook', 40);

    expect(repo.deleteOlderThan(30, 2)).toBe(2);
    expect(eventIds()).toEqual(['old-c', 'boundary', 'new']);

    expect(repo.deleteOlderThan(30, 2)).toBe(1);
    expect(eventIds()).toEqual(['boundary', 'new']);
  });

  it('拒绝无界批次和非法时间戳', () => {
    expect(() => repo.deleteOlderThan(Number.NaN)).toThrow(RangeError);
    expect(() => repo.deleteOlderThan(100, 0)).toThrow(RangeError);
    expect(() => repo.deleteOlderThan(100, 1_001)).toThrow(RangeError);
  });

  it('data v10 提供全局保留索引', () => {
    const sql = database.db.prepare(`
      SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_telemetry_retention'
    `).pluck().get() as string;

    expect(sql.replaceAll(/\s+/g, ' '))
      .toContain('telemetry_events(created_at ASC, id ASC)');
    expect(database.db.pragma('user_version', { simple: true })).toBe(16);
  });

  function eventIds(): string[] {
    return (database.db.prepare(`
      SELECT id FROM telemetry_events ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string }>).map((row) => row.id);
  }
});
