// 测试 memory_node_sources 迁移回填与 MemoryNodeSourcesRepo 的登记/查询语义。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Database,
  MemoryNodeSourcesRepo,
  MigrationsRunner,
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

/** 把 profile 迁移只应用到 v13，模拟 v14 发布前的存量库。 */
function applyProfileMigrationsThroughV13(sqlite: BetterSqlite3.Database): void {
  const directory = fileURLToPath(new URL('../../migrations/profile/', import.meta.url));
  const files = readdirSync(directory)
    .filter((file) => /^0(0[1-9]|1[0-3])_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(`../../migrations/profile/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.pragma('user_version = 13');
}

function insertNode(sqlite: BetterSqlite3.Database, id: string, label: string): void {
  sqlite
    .prepare(
      `INSERT INTO memory_nodes
         (id, label, node_type, description, importance, created_at, updated_at, last_referenced_at)
       VALUES (?, ?, 'entity', ?, 50, 1, 1, 1)`,
    )
    .run(id, label, `desc-${label}`);
}

function insertLazyUpdate(
  sqlite: BetterSqlite3.Database,
  id: string,
  nodeId: string,
  sessionId: string | null,
  turnId: string | null,
  createdAt: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO memory_node_lazy_updates
         (id, node_id, fragment, source_session_id, source_turn_id, created_at)
       VALUES (?, ?, 'fragment', ?, ?, ?)`,
    )
    .run(id, nodeId, sessionId, turnId, createdAt);
}

describe('profile v14 memory_node_sources 迁移', () => {
  it('从存量 lazy_updates 回填溯源，NULL turn 归一为空串，同键取最早时间', () => {
    const sqlite = new BetterSqlite3(':memory:');
    opened.push(sqlite);
    applyProfileMigrationsThroughV13(sqlite);

    insertNode(sqlite, 'node-1', 'Alice');
    insertLazyUpdate(sqlite, 'lu-1', 'node-1', 'session-a', 'turn-1', 100);
    insertLazyUpdate(sqlite, 'lu-2', 'node-1', 'session-a', 'turn-1', 50);
    insertLazyUpdate(sqlite, 'lu-3', 'node-1', 'session-a', null, 200);
    // 无 session 的历史行无法定位来源，跳过而非伪造。
    insertLazyUpdate(sqlite, 'lu-4', 'node-1', null, null, 10);

    new MigrationsRunner(sqlite, 'profile').run();

    const rows = sqlite
      .prepare('SELECT * FROM memory_node_sources ORDER BY created_at ASC')
      .all() as Array<{
        node_id: string; source_session_id: string; source_turn_id: string; created_at: number;
      }>;
    expect(rows).toEqual([
      { node_id: 'node-1', source_session_id: 'session-a', source_turn_id: 'turn-1', created_at: 50 },
      { node_id: 'node-1', source_session_id: 'session-a', source_turn_id: '', created_at: 200 },
    ]);
    expect(sqlite.pragma('user_version', { simple: true })).toBe(16);
  });
});

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
