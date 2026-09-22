// 存储统计按 Turn 生命周期与调用级 Usage 两本事实账汇总，并合并附件账本。
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { DataDirStatsRepo, SessionStatsRepo } from '../../repos/data/storage-stats.js';

let database: Database;

beforeEach(() => {
  database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, cwd, pinned, last_activity_at, created_at, updated_at)
    VALUES ('s1', 'a', 'D:/work', 0, 1, 1, 1), ('s2', 'b', 'D:/work', 0, 1, 1, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns (id, session_id, trigger_type, session_mode, narrative_policy,
      status, created_at)
    VALUES
      ('t1', 's1', 'userMessage', 'chat', 'off', 'completed', 1),
      ('t2', 's1', 'userMessage', 'work', 'always', 'completed', 2),
      ('t3', 's2', 'userMessage', 'chat', 'off', 'completed', 3)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO usage_records (
      id, session_id, turn_id, provider_id, model_id, capability, status,
      input_tokens, output_tokens, duration_ms, created_at
    ) VALUES
      ('u1', 's1', 't1', 'p', 'm', 'llm', 'completed', 100, 50, 10, 1),
      ('u2', 's1', 't2', 'p', 'm', 'llm', 'completed', 200, 80, 20, 2),
      ('u3', 's2', 't3', 'p', 'm', 'llm', 'completed', 10, 5, 30, 3),
      ('manual-compact', 's1', NULL, 'p', 'm', 'llm', 'completed', 40, 10, 40, 4),
      ('speech', 's1', 't1', 'p', 'm', 'tts', 'completed', NULL, NULL, 50, 5)
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
    expect(stats.totalInputTokens).toBe(350);
    expect(stats.totalOutputTokens).toBe(145);
  });
});

describe('SessionStatsRepo.getStats', () => {
  it('Turn 分类与 Session 内全部 LLM 调用分别汇总', () => {
    const stats = new SessionStatsRepo(database.sqlite).getStats('s1');
    expect(stats.turnCount).toBe(2);
    expect(stats.totalInputTokens).toBe(340);
    expect(stats.totalOutputTokens).toBe(140);
    expect(stats.chatTurns).toBe(1);
    expect(stats.workTurns).toBe(1);
    expect(stats.narrativeAlwaysTurns).toBe(1);
    expect(stats.attachmentCount).toBe(2);
    expect(stats.attachmentTotalBytes).toBe(140);
  });
});
