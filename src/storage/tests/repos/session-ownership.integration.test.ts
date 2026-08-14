// 测试移除 Branch 后，Session 与 Turn 的核心归属仍不可被原地篡改。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('Session ownership 数据库约束', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, last_activity_at, created_at, updated_at)
      VALUES ('session-a', 'A', 1, 1, 1), ('session-b', 'B', 1, 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, trigger_type, execution_profile, narrative_policy, status, created_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'chat', 'off', 'completed', 1)
    `).run();
  });

  afterEach(() => {
    database.close();
  });

  it('拒绝修改 Session 主键', () => {
    expect(() => database.db.prepare(
      "UPDATE sessions SET id = 'session-c' WHERE id = 'session-a'",
    ).run()).toThrow(/sessions\.id is immutable/);
  });

  it('拒绝把已有 Turn 移动到另一个 Session', () => {
    expect(() => database.db.prepare(
      "UPDATE turns SET session_id = 'session-b' WHERE id = 'turn-a'",
    ).run()).toThrow(/turns\.session_id is immutable/);
  });

  it('Schema 不再保留 Branch 表和列', () => {
    const tables = database.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).pluck().all() as string[];
    const sessionColumns = database.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    const turnColumns = database.db.pragma('table_info(turns)') as Array<{ name: string }>;

    expect(tables).not.toContain('branches');
    expect(sessionColumns.map((column) => column.name)).not.toContain('active_branch_id');
    expect(turnColumns.map((column) => column.name)).not.toContain('branch_id');
  });
});
