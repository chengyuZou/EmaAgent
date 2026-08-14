// 测试 Session 行新形状（fork 溯源/无 group 与 pinned_at）、项目分组投影、搜索投影与 Fork 重映射。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { SessionsRepo, nextCursorFor, type SessionRow } from '../../repos/data/sessions.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('SessionsRepo integration', () => {
  let database: TestDatabase;
  let repo: SessionsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    repo = new SessionsRepo(database.db);
  });

  afterEach(() => {
    database.close();
  });

  it('schema 定型：sessions 无 group_label/pinned_at，turns 无 user_input/started_at', () => {
    const sessionColumns = (database.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(sessionColumns).toEqual(expect.arrayContaining([
      'pinned', 'forked_from_session_id', 'forked_from_turn_id',
      'execution_profile', 'narrative_policy',
      'preferred_provider_config_id', 'preferred_model_id',
    ]));
    expect(sessionColumns).not.toContain('group_label');
    expect(sessionColumns).not.toContain('pinned_at');
    expect(sessionColumns).not.toContain('parent_session_id');

    const turnColumns = (database.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(turnColumns).toEqual(expect.arrayContaining([
      'trigger_type', 'provider_config_id', 'model_id', 'created_at',
    ]));
    expect(turnColumns).not.toContain('user_input');
    expect(turnColumns).not.toContain('started_at');
  });

  it('listProjects 按 workspace_root 分组：有工作区的进项目区，无工作区的进 pinned/recent', () => {
    insertSession({ id: 'proj-a-1', workspaceRoot: 'D:/work/a', lastActivityAt: 30 });
    insertSession({ id: 'proj-a-2', workspaceRoot: 'D:/work/a', lastActivityAt: 20 });
    insertSession({ id: 'proj-b-1', workspaceRoot: 'D:/work/b', lastActivityAt: 40 });
    insertSession({ id: 'pinned', pinned: true, lastActivityAt: 50 });
    insertSession({ id: 'loose', lastActivityAt: 10 });
    insertSession({ id: 'archived', archivedAt: 60 });

    const projected = repo.listProjects();
    expect(projected.byProject.map((group) => group.workspaceRoot)).toEqual(['D:/work/b', 'D:/work/a']);
    expect(projected.byProject[1]?.sessions.map((row) => row.id)).toEqual(['proj-a-1', 'proj-a-2']);
    expect(projected.pinned.map((row) => row.id)).toEqual(['pinned']);
    expect(projected.recent.map((row) => row.id)).toEqual(['loose']);
    expect(projected.archived.map((row) => row.id)).toEqual(['archived']);
  });

  it('列表投影返回最新 Turn 状态与运行计数', () => {
    insertSession({ id: 's1' });
    insertTurn({ id: 'turn-a', sessionId: 's1', status: 'completed', createdAt: 100, completedAt: 110 });
    insertTurn({ id: 'turn-z', sessionId: 's1', status: 'failed', createdAt: 100, completedAt: 120 });
    insertTurn({ id: 'turn-r', sessionId: 's1', status: 'running', createdAt: 130 });

    expect(repo.listProjects().recent[0]).toMatchObject({
      id: 's1',
      last_turn_status: 'running',
      running_turn_count: 1,
    });
  });

  it('搜索投影与消息删除保持同步', () => {
    insertSession({ id: 's1' });
    insertMessage({ id: 'message-1', sessionId: 's1', text: '可删除搜索正文', createdAt: 100 });
    expect(repo.search('可删除搜索正文', 10)).toHaveLength(1);

    database.db.prepare('DELETE FROM messages WHERE id = ?').run('message-1');
    expect(repo.search('可删除搜索正文', 10)).toHaveLength(0);
  });

  it('fork 截断复制并写入 forked_from 双列，消息与附件归属重映射', () => {
    insertSession({ id: 'source' });
    insertTurn({ id: 'turn-1', sessionId: 'source', status: 'completed', createdAt: 100, completedAt: 110 });
    insertTurn({ id: 'turn-2', sessionId: 'source', status: 'completed', createdAt: 200, completedAt: 210 });
    insertTurn({ id: 'turn-3', sessionId: 'source', status: 'completed', createdAt: 300, completedAt: 310 });
    insertMessage({ id: 'message-1', sessionId: 'source', turnId: 'turn-1', text: 'one', createdAt: 105 });
    insertMessage({ id: 'message-2', sessionId: 'source', turnId: 'turn-2', text: 'two', createdAt: 205 });
    insertMessage({ id: 'message-3', sessionId: 'source', turnId: 'turn-3', text: 'three', createdAt: 305 });
    insertAttachment('attachment-2', 'turn-2', 'source');

    expect(repo.forkInto(asSessionId('source'), asSessionId('fork'), 'Fork', 1_000, asTurnId('turn-2'))).toBe(2);

    expect(repo.findById(asSessionId('fork'))).toMatchObject({
      forked_from_session_id: 'source',
      forked_from_turn_id: 'turn-2',
    });

    const turns = database.db
      .prepare('SELECT id FROM turns WHERE session_id = ? ORDER BY created_at, id')
      .all('fork') as Array<{ id: string }>;
    expect(turns).toHaveLength(2);

    const copiedMessages = database.db
      .prepare('SELECT turn_id FROM messages WHERE session_id = ? ORDER BY created_at, id')
      .all('fork') as Array<{ turn_id: string | null }>;
    expect(copiedMessages).toHaveLength(2);
    expect(copiedMessages.every((message) => turns.some((turn) => turn.id === message.turn_id))).toBe(true);

    const copiedAttachment = database.db
      .prepare('SELECT session_id, turn_id FROM attachments WHERE session_id = ?')
      .get('fork') as { session_id: string; turn_id: string };
    expect(copiedAttachment.session_id).toBe('fork');
    expect(turns.some((turn) => turn.id === copiedAttachment.turn_id)).toBe(true);
  });

  it('完整 fork 时 forked_from_turn_id 为 null', () => {
    insertSession({ id: 'source' });
    insertTurn({ id: 'turn-1', sessionId: 'source', createdAt: 100 });

    repo.forkInto(asSessionId('source'), asSessionId('fork'), 'Fork', 200);

    expect(repo.findById(asSessionId('fork'))).toMatchObject({
      forked_from_session_id: 'source',
      forked_from_turn_id: null,
    });
  });

  it('拒绝不属于来源 Session 的截断 Turn 并回滚 fork', () => {
    insertSession({ id: 'source' });
    insertSession({ id: 'other' });
    insertTurn({ id: 'other-turn', sessionId: 'other', createdAt: 100 });

    expect(() => repo.forkInto(
      asSessionId('source'),
      asSessionId('fork'),
      'Fork',
      1_000,
      asTurnId('other-turn'),
    )).toThrow(/session|turn/i);
    expect(repo.findById(asSessionId('fork'))).toBeUndefined();
  });

  it('keyset 分页不丢边界行，畸形 cursor 明确报错', () => {
    for (const id of ['session-a', 'session-b', 'session-c', 'session-d']) {
      insertSession({ id, pinned: true, lastActivityAt: 1_000 });
    }

    const firstPage = repo.listActive(2);
    const cursor = nextCursorFor(firstPage[firstPage.length - 1] as SessionRow);
    const secondPage = repo.listActive(2, cursor);
    const ids = [...firstPage, ...secondPage].map((row) => row.id);

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(() => repo.listActive(10, 'not-base64url-json')).toThrow('Invalid sessions cursor');
  });

  function insertSession(fixture: {
    id: string;
    pinned?: boolean;
    workspaceRoot?: string;
    lastActivityAt?: number;
    archivedAt?: number | null;
  }): void {
    const timestamp = fixture.lastActivityAt ?? 10;
    database.db.prepare(`
      INSERT INTO sessions
        (id, title, pinned, archived_at, workspace_root, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.id,
      `${fixture.id} session`,
      fixture.pinned ? 1 : 0,
      fixture.archivedAt ?? null,
      fixture.workspaceRoot ?? null,
      timestamp,
      timestamp,
      timestamp,
    );
  }

  function insertTurn(fixture: {
    id: string;
    sessionId: string;
    status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
    createdAt: number;
    completedAt?: number | null;
  }): void {
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, trigger_type, execution_profile, narrative_policy,
         status, created_at, completed_at)
      VALUES (?, ?, 'userMessage', 'chat', 'off', ?, ?, ?)
    `).run(
      fixture.id,
      fixture.sessionId,
      fixture.status ?? 'completed',
      fixture.createdAt,
      fixture.completedAt ?? null,
    );
  }

  function insertMessage(fixture: {
    id: string;
    sessionId: string;
    turnId?: string | null;
    text: string;
    createdAt: number;
  }): void {
    database.db.prepare(`
      INSERT INTO messages
        (id, session_id, turn_id, role, kind, blocks_json, created_at)
      VALUES (?, ?, ?, 'assistant', 'normal', ?, ?)
    `).run(
      fixture.id,
      fixture.sessionId,
      fixture.turnId ?? null,
      JSON.stringify([{ type: 'text', text: fixture.text }]),
      fixture.createdAt,
    );
  }

  function insertAttachment(id: string, turnId: string, sessionId: string): void {
    database.db.prepare(`
      INSERT INTO attachments
        (id, turn_id, session_id, kind, name, mime, source_path, byte_size, source_modified_at, created_at)
      VALUES (?, ?, ?, 'file', 'fixture.txt', 'text/plain', 'fixture.txt', 7, 1, 1)
    `).run(id, turnId, sessionId);
  }
});

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

function asTurnId(value: string): TurnId {
  return value as TurnId;
}
