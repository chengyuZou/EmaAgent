// 测试 MemoryNodeSourcesRepo 的登记、批量查询和级联删除语义。
import { afterEach, describe, expect, it } from 'vitest';
import {
  Database,
  MemoryNodeSourcesRepo,
  type SqliteDb,
} from '../../index.js';

const opened: Array<{ close(): void }> = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function createProfileDb(): Database {
  const database = new Database({ memory: true, kind: 'profile' });
  database.migrate();
  opened.push(database);
  return database;
}

function insertNode(sqlite: SqliteDb, id: string, label: string): void {
  sqlite
    .prepare(
      `INSERT INTO memory_nodes
         (id, label, node_type, description, importance, created_at, updated_at, last_referenced_at)
       VALUES (?, ?, 'entity', ?, 50, 1, 1, 1)`,
    )
    .run(id, label, `desc-${label}`);
}

describe('MemoryNodeSourcesRepo', () => {
  it('record 幂等：同 (node, session, turn) 只保留首次登记时间', () => {
    const db = createProfileDb();
    insertNode(db.sqlite, 'node-1', 'Alice');
    const sources = new MemoryNodeSourcesRepo(db.sqlite);

    sources.record('node-1', 'session-a', 'turn-1', 100);
    sources.record('node-1', 'session-a', 'turn-1', 999);
    sources.record('node-1', 'session-a', 'turn-2', 200);
    sources.record('node-1', 'session-b', null, 300);

    expect(sources.listByNode('node-1')).toEqual([
      { node_id: 'node-1', source_session_id: 'session-a', source_turn_id: 'turn-1', created_at: 100 },
      { node_id: 'node-1', source_session_id: 'session-a', source_turn_id: 'turn-2', created_at: 200 },
      { node_id: 'node-1', source_session_id: 'session-b', source_turn_id: '', created_at: 300 },
    ]);
  });

  it('listByNodes 批量读取多个节点的来源', () => {
    const db = createProfileDb();
    insertNode(db.sqlite, 'node-1', 'Alice');
    insertNode(db.sqlite, 'node-2', 'EmaAgent');
    const sources = new MemoryNodeSourcesRepo(db.sqlite);

    sources.record('node-1', 'session-a', 'turn-1', 100);
    sources.record('node-2', 'session-a', 'turn-1', 100);

    const rows = sources.listByNodes(['node-1', 'node-2']);
    expect(rows.map((r) => r.node_id).sort()).toEqual(['node-1', 'node-2']);
    expect(sources.listByNodes([])).toEqual([]);
  });

  it('节点删除时来源随 ON DELETE CASCADE 清理', () => {
    const db = createProfileDb();
    insertNode(db.sqlite, 'node-1', 'Alice');
    const sources = new MemoryNodeSourcesRepo(db.sqlite);
    sources.record('node-1', 'session-a', 'turn-1', 100);

    db.sqlite.prepare('DELETE FROM memory_nodes WHERE id = ?').run('node-1');

    expect(sources.listByNode('node-1')).toEqual([]);
  });
});
