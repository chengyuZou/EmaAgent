import { describe, expect, it } from 'vitest';
import { Database } from '../database/database.js';

describe('Storage 数据库归属', () => {
  it('profile 和 data 迁移成功, 不创建独立知识库表', () => {
    for (const kind of ['profile', 'data'] as const) {
      const database = new Database({ memory: true, kind });
      try {
        database.migrate();
        const tables = database.sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as Array<{ name: string }>;
        expect(tables.map(table => table.name)).not.toContain('knowledge_bases');
        expect(tables.some(table => /^(document_assets|document_chunks|kb_)/.test(table.name))).toBe(false);
        expect(tables.map(table => table.name)).toContain(kind === 'profile' ? 'settings' : 'sessions');
      } finally {
        database.close();
      }
    }
  });
});
