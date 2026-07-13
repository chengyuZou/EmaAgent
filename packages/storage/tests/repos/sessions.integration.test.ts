import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionId, TurnId } from '@ema-agent/contracts';
import { SessionsRepo, nextCursorFor, type SessionRow } from '../../src/repos/sessions.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

interface SessionFixture {
  id: string;
  title?: string;
  pinned?: boolean;
  lastActivityAt?: number;
  archivedAt?: number | null;
  groupLabel?: string | null;
}

interface TurnFixture {
  id: string;
  sessionId: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  completedAt?: number | null;
}

interface MessageFixture {
  id: string;
  sessionId: string;
  turnId?: string | null;
  text: string;
  createdAt: number;
}

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

  it('applies the production data migrations to the test database', () => {
    const tables = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'turns', 'messages') ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual(['messages', 'sessions', 'turns']);
    expect(database.db.pragma('foreign_keys', { simple: true })).toBe(1);

    const indexes = database.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_sessions_activity',
          'idx_turns_session_latest',
          'idx_turns_running_by_session',
          'idx_messages_session_latest',
          'idx_messages_session_latest_summary'
        )
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      'idx_messages_session_latest',
      'idx_messages_session_latest_summary',
      'idx_sessions_activity',
      'idx_turns_running_by_session',
      'idx_turns_session_latest',
    ]);
  });

  it('separates active and archived sessions in their documented read models', () => {
    insertSession({ id: 'active', lastActivityAt: 30 });
    insertSession({ id: 'archived', lastActivityAt: 40, archivedAt: 50 });

    expect(repo.listActive(10).map((row) => row.id)).toEqual(['active']);
    expect(repo.listGrouped().archived.map((row) => row.id)).toEqual(['archived']);
    expect(repo.search('session', 10).map((row) => row.id)).toEqual(['active']);
  });

  it('returns latest-turn status and completion from a deterministic latest turn', () => {
    insertSession({ id: 's1' });
    insertTurn({ id: 'turn-a', sessionId: 's1', status: 'completed', startedAt: 100, completedAt: 110 });
    insertTurn({ id: 'turn-z', sessionId: 's1', status: 'failed', startedAt: 100, completedAt: 120 });

    const row = repo.listGrouped().recent[0];
    expect(row).toMatchObject({
      id: 's1',
      last_turn_status: 'failed',
      last_turn_completed_at: 120,
      running_turn_count: 0,
    });
  });

  it('derives the running turn count in every session read projection', () => {
    insertSession({ id: 's1' });
    insertTurn({ id: 'running-a', sessionId: 's1', status: 'running', startedAt: 100 });
    insertTurn({ id: 'running-b', sessionId: 's1', status: 'running', startedAt: 200 });
    insertTurn({ id: 'completed', sessionId: 's1', status: 'completed', startedAt: 300 });

    expect(repo.listActive(10)[0]?.running_turn_count).toBe(2);
    expect(repo.listGrouped().recent[0]?.running_turn_count).toBe(2);
    expect(repo.search('s1', 10)[0]?.running_turn_count).toBe(2);
  });

  it('returns all fields from the same newest matching message', () => {
    insertSession({ id: 's1', title: 'Unrelated title' });
    insertMessage({ id: 'message-a', sessionId: 's1', text: 'needle older', createdAt: 100 });
    insertMessage({ id: 'message-z', sessionId: 's1', text: 'needle newest', createdAt: 100 });

    const [result] = repo.search('needle', 10);
    expect(result).toMatchObject({
      match_kind: 'message',
      message_id: 'message-z',
      message_created_at: 100,
      snippet_json: blocks('needle newest'),
    });
  });

  it('searches Chinese visible text through FTS5 and excludes internal blocks', () => {
    insertSession({ id: 'visible', title: 'Unrelated' });
    insertSession({ id: 'internal', title: 'Unrelated' });
    insertMessage({ id: 'visible-message', sessionId: 'visible', text: '今天一起整理桌面记忆', createdAt: 100 });
    database.db.prepare(`
      INSERT INTO messages
        (id, session_id, role, kind, blocks_json, created_at)
      VALUES (?, ?, 'assistant', 'normal', ?, ?)
    `).run(
      'internal-message',
      'internal',
      JSON.stringify([
        { type: 'thinking', thinking: '桌面记忆不能暴露' },
        { type: 'tool_use', id: 'tool-1', name: '桌面记忆', args: { secret: '桌面记忆' } },
      ]),
      100,
    );

    expect(repo.search('桌面记忆', 10).map((row) => row.id)).toEqual(['visible']);
  });

  it('keeps message search documents synchronized on delete', () => {
    insertSession({ id: 's1', title: 'Unrelated' });
    insertTurn({ id: 'turn-1', sessionId: 's1', startedAt: 100 });
    insertMessage({ id: 'message-1', sessionId: 's1', turnId: 'turn-1', text: '可删除搜索正文', createdAt: 100 });
    expect(repo.search('可删除搜索正文', 10)).toHaveLength(1);

    database.db.prepare('DELETE FROM messages WHERE id = ?').run('message-1');

    expect(repo.search('可删除搜索正文', 10)).toHaveLength(0);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM message_search_documents WHERE message_id = ?',
    ).pluck().get('message-1')).toBe(0);
  });

  it('rebuilds the search projection when visible message blocks change', () => {
    insertSession({ id: 's1', title: 'Unrelated' });
    insertMessage({ id: 'message-1', sessionId: 's1', text: 'oldtokenalpha', createdAt: 100 });

    database.db.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?')
      .run(blocks('newtokenbeta'), 'message-1');

    expect(repo.search('oldtokenalpha', 10)).toHaveLength(0);
    expect(repo.search('newtokenbeta', 10).map((row) => row.id)).toEqual(['s1']);
  });

  it('forks through the requested turn and remaps message and attachment ownership', () => {
    insertSession({ id: 'source' });
    insertTurn({ id: 'turn-1', sessionId: 'source', status: 'completed', startedAt: 100, completedAt: 110 });
    insertTurn({ id: 'turn-2', sessionId: 'source', status: 'completed', startedAt: 200, completedAt: 210 });
    insertTurn({ id: 'turn-3', sessionId: 'source', status: 'completed', startedAt: 300, completedAt: 310 });
    insertMessage({ id: 'message-1', sessionId: 'source', turnId: 'turn-1', text: 'one', createdAt: 105 });
    insertMessage({ id: 'message-2', sessionId: 'source', turnId: 'turn-2', text: 'two', createdAt: 205 });
    insertMessage({ id: 'message-3', sessionId: 'source', turnId: 'turn-3', text: 'three', createdAt: 305 });
    insertAttachment('attachment-2', 'turn-2', 'source');

    expect(repo.forkInto(asSessionId('source'), asSessionId('fork'), 'Fork', 1_000, asTurnId('turn-2'))).toBe(2);

    const fork = repo.findById(asSessionId('fork'));
    expect(fork?.parent_session_id).toBe('source');
    expect(fork?.active_branch_id).toBeNull();

    const turns = database.db
      .prepare('SELECT id, branch_id FROM turns WHERE session_id = ? ORDER BY started_at, id')
      .all('fork') as Array<{ id: string; branch_id: string | null }>;
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.branch_id === null)).toBe(true);
    expect(turns.map((turn) => turn.id)).not.toContain('turn-1');
    expect(turns.map((turn) => turn.id)).not.toContain('turn-2');

    const copiedMessages = database.db
      .prepare('SELECT turn_id, blocks_json FROM messages WHERE session_id = ? ORDER BY created_at, id')
      .all('fork') as Array<{ turn_id: string | null; blocks_json: string }>;
    expect(copiedMessages).toHaveLength(2);
    expect(copiedMessages.every((message) => turns.some((turn) => turn.id === message.turn_id))).toBe(true);

    const copiedAttachment = database.db
      .prepare('SELECT session_id, turn_id FROM turn_attachments WHERE session_id = ?')
      .get('fork') as { session_id: string; turn_id: string };
    expect(copiedAttachment.session_id).toBe('fork');
    expect(turns.some((turn) => turn.id === copiedAttachment.turn_id)).toBe(true);
    expect(repo.search('two', 10).map((row) => row.id)).toContain('fork');
  });

  it('uses stable turn and message boundaries when fork timestamps are equal', () => {
    insertSession({ id: 'source' });
    insertTurn({ id: 'turn-a', sessionId: 'source', startedAt: 100 });
    insertTurn({ id: 'turn-b', sessionId: 'source', startedAt: 100 });
    insertTurn({ id: 'turn-c', sessionId: 'source', startedAt: 100 });
    insertMessage({ id: 'message-a', sessionId: 'source', turnId: 'turn-a', text: 'a', createdAt: 200 });
    insertMessage({ id: 'message-b', sessionId: 'source', turnId: 'turn-b', text: 'b', createdAt: 200 });
    insertMessage({ id: 'message-c', sessionId: 'source', turnId: 'turn-c', text: 'c', createdAt: 200 });
    insertMessage({ id: 'message-aa-global', sessionId: 'source', text: 'global before', createdAt: 200 });
    insertMessage({ id: 'message-z-global', sessionId: 'source', text: 'global after', createdAt: 200 });

    repo.forkInto(asSessionId('source'), asSessionId('fork'), 'Fork', 1_000, asTurnId('turn-b'));

    const copiedTurns = database.db
      .prepare('SELECT user_input, started_at FROM turns WHERE session_id = ? ORDER BY started_at, id')
      .all('fork');
    expect(copiedTurns).toHaveLength(2);

    const copiedText = (database.db
      .prepare('SELECT blocks_json FROM messages WHERE session_id = ? ORDER BY created_at, id')
      .all('fork') as Array<{ blocks_json: string }>)
      .map((row) => row.blocks_json);
    expect(copiedText).toContain(blocks('a'));
    expect(copiedText).toContain(blocks('b'));
    expect(copiedText).not.toContain(blocks('c'));
    expect(copiedText).toContain(blocks('global before'));
    expect(copiedText).not.toContain(blocks('global after'));
  });

  it('does not lose sessions sharing a keyset page boundary', () => {
    for (const id of ['session-a', 'session-b', 'session-c', 'session-d']) {
      insertSession({ id, pinned: true, lastActivityAt: 1_000 });
    }

    const firstPage = repo.listActive(2);
    const cursor = nextCursorFor(firstPage[firstPage.length - 1] as SessionRow);
    const secondPage = repo.listActive(2, cursor);
    const ids = [...firstPage, ...secondPage].map((row) => row.id);

    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('rejects malformed cursors instead of silently restarting pagination', () => {
    insertSession({ id: 'session-a' });

    expect(() => repo.listActive(10, 'not-base64url-json')).toThrow('Invalid sessions cursor');
  });

  it('rejects a missing cutoff turn and rolls back the fork', () => {
    insertSession({ id: 'source' });
    insertTurn({ id: 'turn-1', sessionId: 'source', startedAt: 100 });

    expect(() => repo.forkInto(
      asSessionId('source'),
      asSessionId('fork'),
      'Fork',
      1_000,
      asTurnId('missing-turn'),
    )).toThrow(/turn/i);
    expect(repo.findById(asSessionId('fork'))).toBeUndefined();
  });

  it('rejects a cutoff turn owned by another session', () => {
    insertSession({ id: 'source' });
    insertSession({ id: 'other' });
    insertTurn({ id: 'source-turn', sessionId: 'source', startedAt: 100 });
    insertTurn({ id: 'other-turn', sessionId: 'other', startedAt: 200 });

    expect(() => repo.forkInto(
      asSessionId('source'),
      asSessionId('fork'),
      'Fork',
      1_000,
      asTurnId('other-turn'),
    )).toThrow(/session|turn|ownership/i);
    expect(repo.findById(asSessionId('fork'))).toBeUndefined();
  });

  it('treats LIKE wildcard characters in search input literally', () => {
    insertSession({ id: 'percent', title: 'Progress 100%' });
    insertSession({ id: 'underscore', title: 'user_name' });
    insertSession({ id: 'plain', title: 'ordinary session' });

    expect(repo.search('%', 10).map((row) => row.id)).toEqual(['percent']);
    expect(repo.search('_', 10).map((row) => row.id)).toEqual(['underscore']);
  });

  function insertSession(fixture: SessionFixture): void {
    const timestamp = fixture.lastActivityAt ?? 10;
    database.db.prepare(`
      INSERT INTO sessions
        (id, title, pinned, archived_at, group_label, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixture.id,
      fixture.title ?? `${fixture.id} session`,
      fixture.pinned ? 1 : 0,
      fixture.archivedAt ?? null,
      fixture.groupLabel ?? null,
      timestamp,
      timestamp,
      timestamp,
    );
  }

  function insertTurn(fixture: TurnFixture): void {
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, mode, status, user_input, started_at, completed_at)
      VALUES (?, ?, 'chat', ?, '', ?, ?)
    `).run(
      fixture.id,
      fixture.sessionId,
      fixture.status ?? 'completed',
      fixture.startedAt,
      fixture.completedAt ?? null,
    );
  }

  function insertMessage(fixture: MessageFixture): void {
    database.db.prepare(`
      INSERT INTO messages
        (id, session_id, turn_id, role, kind, blocks_json, created_at)
      VALUES (?, ?, ?, 'assistant', 'normal', ?, ?)
    `).run(
      fixture.id,
      fixture.sessionId,
      fixture.turnId ?? null,
      blocks(fixture.text),
      fixture.createdAt,
    );
  }

  function insertAttachment(id: string, turnId: string, sessionId: string): void {
    database.db.prepare(`
      INSERT INTO turn_attachments
        (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
      VALUES (?, ?, ?, 'fixture.txt', 'text/plain', 7, 1, 'fixture.txt', 1)
    `).run(id, turnId, sessionId);
  }
});

function blocks(text: string): string {
  return JSON.stringify([{ type: 'text', text }]);
}

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

function asTurnId(value: string): TurnId {
  return value as TurnId;
}
