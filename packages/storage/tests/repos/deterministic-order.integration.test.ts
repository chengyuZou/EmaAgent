import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asSessionId, asTurnId } from '@ema-agent/contracts';
import {
  AgentTaskMessagesRepo,
  AgentTasksRepo,
  Database,
  MemoryLazyUpdatesRepo,
  MemoryNodesRepo,
  MigrationsRunner,
  PendingFragmentsRepo,
  TelemetryRepo,
} from '../../src/index.js';
import {
  extractMessageSearchText,
  tokenizeMessageSearchText,
} from '../../src/message-search.js';

describe('N-012 Data DB 确定性事件顺序', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    insertSessionAndTurn(database);
  });

  afterEach(() => database.close());

  it('AgentTask transcript 使用 task 内 sequence 保留真实写入顺序', () => {
    const tasks = new AgentTasksRepo(database.sqlite);
    tasks.insert({
      id: 'task-a',
      sessionId: 'session-a',
      turnId: 'turn-a',
      parentId: null,
      createdAt: 1,
    });
    const messages = new AgentTaskMessagesRepo(database.sqlite);
    for (const [role, text] of [
      ['tool_call', 'call'],
      ['tool_result', 'result'],
      ['assistant', 'answer'],
    ] as const) {
      messages.insert({
        taskId: 'task-a',
        role,
        content: { text },
        createdAt: 1_000,
      });
    }

    const rows = messages.listForTask('task-a');
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(rows.map((row) => JSON.parse(row.content_json).text))
      .toEqual(['call', 'result', 'answer']);
  });

  it('PendingFragment 优先按业务时间 at，再使用 created_at 和 id 稳定排序', () => {
    const repo = new PendingFragmentsRepo(database.sqlite);
    const base = {
      sessionId: asSessionId('session-a'),
      turnId: asTurnId('turn-a'),
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

    expect(repo.listBySession(asSessionId('session-a')).map((row) => row.id))
      .toEqual(['a-same-time', 'z-same-time', 'assistant-later']);
  });

  it('Telemetry 同毫秒边界按 id 倒序稳定选择', () => {
    const repo = new TelemetryRepo(database.sqlite);
    for (const id of ['event-a', 'event-c', 'event-b']) {
      repo.insertEvent({
        id,
        session_id: 'session-a',
        turn_id: 'turn-a',
        kind: 'test',
        payload_json: '{}',
        created_at: 1_000,
      });
    }

    expect(repo.listEvents('test', 2).map((row) => row.id))
      .toEqual(['event-c', 'event-b']);
  });

  it('data v9 安装顺序列和对应复合索引', () => {
    const messageColumns = database.sqlite
      .prepare('PRAGMA table_info(agent_task_messages)')
      .all() as Array<{ name: string; notnull: number }>;
    const sequence = messageColumns.find((column) => column.name === 'sequence');
    expect(sequence).toMatchObject({ notnull: 1 });

    expect(indexSql(database, 'idx_atm_task_sequence'))
      .toContain('agent_task_messages(task_id, sequence ASC)');
    expect(indexSql(database, 'idx_pending_fragments_session').replaceAll(/\s+/g, ' '))
      .toContain('pending_fragments(session_id, at ASC, created_at ASC, id ASC)');
    expect(indexSql(database, 'idx_telemetry_kind').replaceAll(/\s+/g, ' '))
      .toContain('telemetry_events(kind, created_at DESC, id DESC)');
    expect(database.currentVersion()).toBe(12);
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
      expect(database.currentVersion()).toBe(6);
    } finally {
      database.close();
    }
  });
});

describe('data v8 到 v9 迁移', () => {
  it('保留旧 transcript 并为每个 task 确定性回填 sequence', () => {
    const sqlite = new BetterSqlite3(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      applyDataMigrationsThroughV8(sqlite);
      sqlite.prepare(`
        INSERT INTO sessions (id, title, created_at, updated_at)
        VALUES ('session-a', 'Session A', 1, 1)
      `).run();
      sqlite.prepare(`
        INSERT INTO agent_tasks
          (id, session_id, status, created_at, updated_at)
        VALUES ('task-a', 'session-a', 'running', 1, 1)
      `).run();
      sqlite.prepare(`
        INSERT INTO turns
          (id, session_id, mode, status, user_input, started_at)
        VALUES ('turn-a', 'session-a', 'agent', 'completed', 'test', 1)
      `).run();
      sqlite.prepare(`
        INSERT INTO turn_usage
          (turn_id, llm_provider, model_id, input_tokens, output_tokens, cost_usd, duration_ms, created_at)
        VALUES ('turn-a', 'openai-llm', 'model-a', 10, 20, 0.01, 500, 2)
      `).run();
      const insert = sqlite.prepare(`
        INSERT INTO agent_task_messages
          (id, task_id, role, content_json, created_at)
        VALUES (?, 'task-a', 'assistant', '{}', 1000)
      `);
      for (const id of ['message-z', 'message-a', 'message-m']) insert.run(id);

      new MigrationsRunner(sqlite, 'data').run();

      const rows = sqlite.prepare(`
        SELECT id, sequence FROM agent_task_messages
        ORDER BY sequence ASC
      `).all() as Array<{ id: string; sequence: number }>;
      expect(rows).toEqual([
        { id: 'message-a', sequence: 1 },
        { id: 'message-m', sequence: 2 },
        { id: 'message-z', sequence: 3 },
      ]);
      expect(sqlite.prepare(`
        SELECT turn_id, model_id, duration_ms FROM llm_turn_metrics WHERE turn_id = 'turn-a'
      `).get()).toEqual({ turn_id: 'turn-a', model_id: 'model-a', duration_ms: 500 });
      expect(sqlite.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_usage'
      `).get()).toBeUndefined();
      expect(sqlite.pragma('user_version', { simple: true })).toBe(12);
    } finally {
      sqlite.close();
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
      (id, session_id, mode, status, user_input, started_at)
    VALUES ('turn-a', 'session-a', 'agent', 'completed', 'test', 1)
  `).run();
}

function indexSql(database: Database, name: string): string {
  return database.sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).pluck().get(name) as string;
}

function applyDataMigrationsThroughV8(sqlite: BetterSqlite3.Database): void {
  sqlite.function('ema_message_search_text', { deterministic: true }, extractMessageSearchText);
  sqlite.function('ema_segment_fts', { deterministic: true }, tokenizeMessageSearchText);
  const directory = fileURLToPath(new URL('../../src/migrations/data/', import.meta.url));
  const files = readdirSync(directory)
    .filter((file) => /^00[1-8]_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(`../../src/migrations/data/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.pragma('user_version = 8');
}
