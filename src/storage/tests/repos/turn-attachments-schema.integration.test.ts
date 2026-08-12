// 锁定 turn_attachments 新表结构:kind 判别列、图片受管副本列、无 status 死列。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../index.js';

describe('turn_attachments schema（file/image 判别联合）', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
  });

  afterEach(() => database.close());

  it('表字段集稳定:kind 判别 + 受管副本列,无 status/local_path', () => {
    const cols = database.sqlite
      .prepare('PRAGMA table_info(turn_attachments)')
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toEqual([
      'id', 'turn_id', 'session_id', 'kind', 'name', 'mime',
      'source_path', 'byte_size', 'source_modified_at',
      'image_path', 'image_byte_size', 'created_at',
    ]);
    expect(colNames).not.toContain('status');
    expect(colNames).not.toContain('local_path');
  });
});
