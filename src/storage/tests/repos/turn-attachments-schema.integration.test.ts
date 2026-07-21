import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../index.js';

// B-067：锁定 turn_attachments 表字段集，与 contracts TurnAttachment 注释承诺对齐。
// TurnAttachment（UI 元数据视图）的字段经 camelCase → snake_case 映射后必须都能从
// turn_attachments 表投影：id→id, name→name, mimeType→mime, size→size,
// mtime→mtime, localPath→local_path。注释曾错误声称存在 messages.attachments_json
// 列（不存在）；本测试锁定真实表 schema，防注释与 SQL 再次漂移。
describe('B-067 turn_attachments schema 与 TurnAttachment 契约对齐', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
  });

  afterEach(() => database.close());

  it('turn_attachments 表字段集稳定，TurnAttachment UI 字段均可投影', () => {
    const cols = database.sqlite
      .prepare('PRAGMA table_info(turn_attachments)')
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    // 完整表字段（含 turn/session 关联列与 created_at 审计列）
    expect(colNames).toHaveLength(9);
    for (const c of [
      'id', 'turn_id', 'session_id',
      'name', 'mime', 'size', 'mtime', 'local_path', 'created_at',
    ]) {
      expect(colNames).toContain(c);
    }

    // TurnAttachment UI 字段（camelCase）映射到的列都真实存在
    const uiFieldToColumn: Record<string, string> = {
      id:        'id',
      name:      'name',
      mimeType:  'mime',
      size:      'size',
      mtime:     'mtime',
      localPath: 'local_path',
    };
    for (const col of Object.values(uiFieldToColumn)) {
      expect(colNames).toContain(col);
    }
  });
});
