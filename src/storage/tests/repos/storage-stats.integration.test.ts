// 存储统计的两层汇总:两本新附件账 + 同表合并指标(turns 条件聚合)的真实计数。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { DataDirStatsRepo, SessionStatsRepo } from '../../repos/data/storage-stats.js';

let database: Database;

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, pinned, last_activity_at, created_at, updated_at)
    VALUES ('s1', 'a', 0, 1, 1, 1), ('s2', 'b', 0, 1, 1, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, execution_profile, narrative_policy,
      status, usage_input_tokens, usage_output_tokens, created_at)
    VALUES
      ('t1', 's1', 'userMessage', 'chat', 'off', 'completed', 100, 50, 1),
      ('t2', 's1', 'userMessage', 'work', 'always', 'completed', 200, 80, 2),
      ('t3', 's2', 'userMessage', 'chat', 'off', 'completed', 10, 5, 3)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO messages (id, session_id, turn_id, role, kind, blocks_json, interrupted, created_at)
    VALUES ('m1', 's1', 't1', 'user', 'normal', '"x"', 0, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO attachment_images (path, session_id, name, byte_size, created_at)
    VALUES ('/a.png', 's1', 'a.png', 100, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO attachment_pasted_texts (path, session_id, byte_size, created_at)
    VALUES ('/b.txt', 's1', 40, 2), ('/c.txt', 's2', 60, 3)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO attachment_vision_descriptions_caches (path, text, byte_size, created_at, last_accessed_at)
    VALUES ('/a.png', '一只猫', 9, 1, 1)
  `).run();
});

afterEach(() => {
  database.close();
});

describe('DataDirStatsRepo.getStats', () => {
  it('附件统计来自 images+pasted 两本新账, vision 单列', () => {
    const stats = new DataDirStatsRepo(database.sqlite).getStats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.turnCount).toBe(3);
    expect(stats.messageCount).toBe(1);
    expect(stats.attachmentCount).toBe(3);
    expect(stats.attachmentTotalBytes).toBe(200);
    expect(stats.visionDescriptionCount).toBe(1);
    expect(stats.visionDescriptionBytes).toBe(9);
  });
});

describe('SessionStatsRepo.getStats', () => {
  it('turns 的条件聚合指标与同表合并计数全部正确', () => {
    const stats = new SessionStatsRepo(database.sqlite).getStats('s1');
    expect(stats.turnCount).toBe(2);
    expect(stats.totalInputTokens).toBe(300);
    expect(stats.totalOutputTokens).toBe(130);
    expect(stats.chatTurns).toBe(1);
    expect(stats.workTurns).toBe(1);
    expect(stats.narrativeAlwaysTurns).toBe(1);
    expect(stats.attachmentCount).toBe(2);
    expect(stats.attachmentTotalBytes).toBe(140);
  });
});
