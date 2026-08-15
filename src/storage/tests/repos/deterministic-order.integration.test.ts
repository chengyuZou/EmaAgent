// 测试 Data/Profile 事件在相同时间戳下仍保持确定顺序。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRunMessagesRepo,
  AgentRunsRepo,
  Database,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  PendingFragmentsRepo,
} from '../../index.js';

describe('N-012 Data DB 确定性事件顺序', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    insertSessionAndTurn(database);
  });

  afterEach(() => database.close());

  it('AgentRun transcript 使用 run 内 sequence 保留真实写入顺序', () => {
    const runs = new AgentRunsRepo(database.sqlite);
    runs.insert({
      id: 'run-a',
      sessionId: 'session-a',
      parentTurnId: 'turn-a',
      kind: 'subagent',
      createdAt: 1,
    });
    const messages = new AgentRunMessagesRepo(database.sqlite);
    for (const [role, text] of [
      ['tool_call', 'call'],
      ['tool_result', 'result'],
      ['assistant', 'answer'],
    ] as const) {
      messages.insert({
        agentRunId: 'run-a',
        role,
        content: { text },
        createdAt: 1_000,
      });
    }

    const rows = messages.listForRun('run-a');
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(rows.map((row) => JSON.parse(row.content_json).text))
      .toEqual(['call', 'result', 'answer']);
  });

  it('PendingFragment 优先按业务时间 at，再使用 created_at 和 id 稳定排序', () => {
    const repo = new PendingFragmentsRepo(database.sqlite);
    const base = {
      sessionId: 'session-a',
      turnId: 'turn-a',
      role: 'user' as const,
      createdAt: 1_000,
    };
    repo.insert({ ...base, id: 'z-same-time', content: 'z', at: 100 });
    repo.insert({ ...base, id: 'a-same-time', content: 'a', at: 100 });
    repo.insert({
      ...base,
      id: 'assistant-later',
      role: 'assistant',
      content: 'assistant',
      at: 101,
    });

    expect(repo.listBySession('session-a').map((row) => row.id))
      .toEqual(['a-same-time', 'z-same-time', 'assistant-later']);
  });

  it('当前 Schema 安装 AgentRun 顺序列和对应复合索引', () => {
    const messageColumns = database.sqlite
      .prepare('PRAGMA table_info(agent_run_messages)')
      .all() as Array<{ name: string; notnull: number }>;
    const sequence = messageColumns.find((column) => column.name === 'sequence');
    expect(sequence).toMatchObject({ notnull: 1 });

    const sequenceConstraint = (database.sqlite.prepare(
      `PRAGMA index_list(agent_run_messages)`,
    ).all() as Array<{ name: string; unique: number; origin: string }>)
      .find((index) => index.unique === 1 && index.origin === 'u');
    expect(sequenceConstraint).toBeDefined();
    expect(database.sqlite.prepare(`PRAGMA index_info(${sequenceConstraint!.name})`).all())
      .toEqual([
        expect.objectContaining({ seqno: 0, name: 'agent_run_id' }),
        expect.objectContaining({ seqno: 1, name: 'sequence' }),
      ]);
    expect(indexSql(database, 'idx_pending_fragments_session').replaceAll(/\s+/g, ' '))
      .toContain('pending_fragments(session_id, at ASC, created_at ASC, id ASC)');
    expect(database.sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_events'
    `).get()).toBeUndefined();
    expect(database.currentVersion()).toBe(1);
  });
});

describe('N-012 Profile DB MemoryLazyUpdate 顺序', () => {
  it('相同 created_at 时按 id 稳定排序并使用复合索引', () => {
    const database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    try {
      new MemoryNodesRepo(database.sqlite).insert({
        id: 'node-a',
        label: 'Node A',
        nodeType: 'entity',
        description: 'node',
        createdAt: 1,
      });
      const repo = new MemoryLazyUpdatesRepo(database.sqlite);
      for (const id of ['update-c', 'update-a', 'update-b']) {
        repo.append({
          id,
          nodeId: 'node-a',
          fragment: id,
          createdAt: 1_000,
        });
      }

      expect(repo.listByNode('node-a').map((row) => row.id))
        .toEqual(['update-a', 'update-b', 'update-c']);
      expect(indexSql(database, 'idx_lazy_updates_node').replaceAll(/\s+/g, ' '))
        .toContain('memory_node_lazy_updates(node_id, created_at ASC, id ASC)');
      expect(database.currentVersion()).toBe(1);
    } finally {
      database.close();
    }
  });
});

function insertSessionAndTurn(database: Database): void {
  database.sqlite.prepare(`
    INSERT INTO sessions (id, title, created_at, updated_at)
    VALUES ('session-a', 'Session A', 1, 1)
  `).run();
  database.sqlite.prepare(`
    INSERT INTO turns
      (id, session_id, trigger_type, execution_profile, narrative_policy, status, created_at)
    VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'off', 'completed', 1)
  `).run();
}

function indexSql(database: Database, name: string): string {
  return database.sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).pluck().get(name) as string;
}
