// 测试 Session 复合归属约束拒绝跨会话引用并保持级联语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

interface RejectedWrite {
  name: string;
  sql: string;
  params: unknown[];
  error: string;
}

describe('B-005 Session ownership 数据库约束', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
    seedOwnershipFixtures(database);
  });

  afterEach(() => {
    database.close();
  });

  it('允许同一 Session 内的合法关系', () => {
    expect(rowCount('sessions')).toBe(2);
    expect(rowCount('branches')).toBe(2);
    expect(rowCount('turns')).toBe(2);
    expect(rowCount('messages')).toBe(2);
    expect(rowCount('agent_runs')).toBe(2);

    expect(() => database.db.prepare(
      'UPDATE sessions SET active_branch_id = ? WHERE id = ?',
    ).run('branch-a', 'session-a')).not.toThrow();
  });

  it('拒绝所有已知跨 Session INSERT 入口且不留残行', () => {
    const writes: RejectedWrite[] = [
      {
        name: 'branch parent',
        sql: `INSERT INTO branches
                (id, session_id, parent_branch_id, fork_from_turn_id, created_at)
              VALUES (?, ?, ?, NULL, 10)`,
        params: ['cross-branch-parent', 'session-a', 'branch-b'],
        error: 'ownership_violation: branches.parent_branch_id',
      },
      {
        name: 'branch fork turn',
        sql: `INSERT INTO branches
                (id, session_id, parent_branch_id, fork_from_turn_id, created_at)
              VALUES (?, ?, ?, ?, 10)`,
        params: ['cross-branch-turn', 'session-a', 'branch-a', 'turn-b'],
        error: 'ownership_violation: branches.fork_from_turn_id',
      },
      {
        name: 'turn branch',
        sql: `INSERT INTO turns
                (id, session_id, branch_id, trigger_type, execution_profile, narrative_policy,
                 status, user_input, started_at)
              VALUES (?, ?, ?, 'userMessage', 'chat', 'off', 'pending', '', 10)`,
        params: ['cross-turn', 'session-a', 'branch-b'],
        error: 'ownership_violation: turns.branch_id',
      },
      {
        name: 'message turn',
        sql: `INSERT INTO messages
                (id, session_id, turn_id, role, kind, blocks_json, created_at)
              VALUES (?, ?, ?, 'user', 'normal', '"cross"', 10)`,
        params: ['cross-message', 'session-a', 'turn-b'],
        error: 'ownership_violation: messages.turn_id',
      },
      {
        name: 'pending fragment turn',
        sql: `INSERT INTO pending_fragments
                (id, session_id, turn_id, role, content, at, created_at)
              VALUES (?, ?, ?, 'user', 'cross', 10, 10)`,
        params: ['cross-fragment', 'session-a', 'turn-b'],
        error: 'ownership_violation: pending_fragments.turn_id',
      },
      {
        name: 'session note message',
        sql: `INSERT INTO session_notes
                (session_id, body, last_message_id, updated_at)
              VALUES (?, '', ?, 10)`,
        params: ['session-a', 'message-b'],
        error: 'ownership_violation: session_notes.last_message_id',
      },
      {
        name: 'audio segment turn',
        sql: `INSERT INTO turn_audio_segments
                (id, turn_id, session_id, sentence_index, storage_path, mime_type,
                 byte_size, text, created_at)
              VALUES (?, ?, ?, 0, 'audio.wav', 'audio/wav', 1, 'cross', 10)`,
        params: ['cross-audio-segment', 'turn-b', 'session-a'],
        error: 'ownership_violation: turn_audio_segments.turn_id',
      },
      {
        name: 'merged audio turn',
        sql: `INSERT INTO turn_audio_merged
                (turn_id, session_id, storage_path, mime_type, byte_size,
                 segment_count, created_at)
              VALUES (?, ?, 'merged.wav', 'audio/wav', 1, 1, 10)`,
        params: ['turn-b', 'session-a'],
        error: 'ownership_violation: turn_audio_merged.turn_id',
      },
      {
        name: 'attachment turn',
        sql: `INSERT INTO turn_attachments
                (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
              VALUES (?, ?, ?, 'cross.txt', 'text/plain', 1, 1, 'cross.txt', 10)`,
        params: ['cross-attachment', 'turn-b', 'session-a'],
        error: 'ownership_violation: turn_attachments.turn_id',
      },
      {
        name: 'artifact turn',
        sql: `INSERT INTO artifacts
                (id, session_id, turn_id, type, title, content, content_location,
                 meta_json, created_at, updated_at)
              VALUES (?, ?, ?, 'text', 'cross', 'cross', 'inline', '{}', 10, 10)`,
        params: ['cross-artifact', 'session-a', 'turn-b'],
        error: 'ownership_violation: artifacts.turn_id',
      },
      {
        name: 'agent run parent turn',
        sql: `INSERT INTO agent_runs
                (id, session_id, parent_turn_id, kind, status, created_at, updated_at)
              VALUES (?, ?, ?, 'subagent', 'running', 10, 10)`,
        params: ['cross-run-turn', 'session-a', 'turn-b'],
        error: 'ownership_violation: agent_runs.parent_turn_id',
      },
      {
        name: 'agent run parent run',
        sql: `INSERT INTO agent_runs
                (id, session_id, parent_turn_id, parent_agent_run_id,
                 kind, status, created_at, updated_at)
              VALUES (?, ?, 'turn-a', ?, 'subagent', 'running', 10, 10)`,
        params: ['cross-run-parent', 'session-a', 'run-b'],
        error: 'ownership_violation: agent_runs.parent_agent_run_id',
      },
      {
        name: 'kb activation turn',
        sql: `INSERT INTO kb_activations
                (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
              VALUES (?, 'call', 'kb', 'asset', ?, ?, 10)`,
        params: ['cross-kb-activation', 'session-a', 'turn-b'],
        error: 'ownership_violation: kb_activations.turn_id',
      },
    ];

    for (const write of writes) {
      expect(
        () => database.db.prepare(write.sql).run(...write.params),
        write.name,
      ).toThrow(write.error);
    }

    expect(database.db.prepare(
      `SELECT COUNT(*) FROM branches WHERE id LIKE 'cross-%'`,
    ).pluck().get()).toBe(0);
    expect(database.db.prepare(
      `SELECT COUNT(*) FROM messages WHERE id LIKE 'cross-%'`,
    ).pluck().get()).toBe(0);
    expect(database.db.prepare(
      `SELECT COUNT(*) FROM agent_runs WHERE id LIKE 'cross-%'`,
    ).pluck().get()).toBe(0);
  });

  it('拒绝跨 Session 换引用和移动已有实体', () => {
    expect(() => database.db.prepare(
      'UPDATE sessions SET active_branch_id = ? WHERE id = ?',
    ).run('branch-b', 'session-a')).toThrow(
      'ownership_violation: sessions.active_branch_id',
    );

    expect(() => database.db.prepare(
      'UPDATE messages SET turn_id = ? WHERE id = ?',
    ).run('turn-b', 'message-a')).toThrow(
      'ownership_violation: messages.turn_id',
    );

    expect(() => database.db.prepare(
      'UPDATE turns SET session_id = ? WHERE id = ?',
    ).run('session-b', 'turn-a')).toThrow(
      'ownership_violation: turns.session_id is immutable',
    );

    expect(() => database.db.prepare(
      'UPDATE branches SET session_id = ? WHERE id = ?',
    ).run('session-b', 'branch-a')).toThrow(
      'ownership_violation: branches.session_id is immutable',
    );
  });

  it('保留 CASCADE/SET NULL，并清理历史裸引用', () => {
    insertDeletableTurnGraph(database);

    database.db.prepare('DELETE FROM turns WHERE id = ?').run('turn-delete');

    expect(database.db.prepare(
      'SELECT turn_id FROM messages WHERE id = ?',
    ).pluck().get('message-delete')).toBeNull();
    expect(database.db.prepare(
      'SELECT turn_id FROM artifacts WHERE id = ?',
    ).pluck().get('artifact-delete')).toBeNull();
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM agent_runs WHERE id = ?',
    ).pluck().get('run-delete')).toBe(0);
    expect(database.db.prepare(
      'SELECT turn_id FROM kb_activations WHERE id = ?',
    ).pluck().get('kb-delete')).toBeNull();

    for (const table of [
      'pending_fragments',
      'turn_audio_segments',
      'turn_audio_merged',
      'turn_attachments',
    ]) {
      expect(rowCount(table), table).toBe(0);
    }

    database.db.prepare('DELETE FROM messages WHERE id = ?').run('message-delete');
    expect(database.db.prepare(
      'SELECT last_message_id FROM session_notes WHERE session_id = ?',
    ).pluck().get('session-a')).toBeNull();

    database.db.prepare('DELETE FROM agent_runs WHERE id = ?').run('run-a');
    expect(database.db.prepare(
      'SELECT parent_agent_run_id FROM agent_runs WHERE id = ?',
    ).pluck().get('run-child')).toBeNull();
  });

  it('安装全部 ownership trigger', () => {
    const triggerNames = database.db.prepare(`
      SELECT name
        FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'trg_%_owner_%'
       ORDER BY name
    `).pluck().all() as string[];

    expect(triggerNames).toHaveLength(28);
    expect(triggerNames).toContain('trg_sessions_owner_insert');
    expect(triggerNames).toContain('trg_turns_owner_delete_cleanup');
    expect(triggerNames).toContain('trg_tool_executions_owner_insert');
    expect(triggerNames).toContain('trg_tool_executions_owner_update');
    expect(triggerNames).toContain('trg_agent_runs_owner_insert');
    expect(triggerNames).toContain('trg_agent_runs_owner_update');
  });

  function rowCount(table: string): number {
    return database.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
  }
});

function seedOwnershipFixtures(database: TestDatabase): void {
  const db = database.db;
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, title, created_at, updated_at)
    VALUES (?, ?, 1, 1)
  `);
  insertSession.run('session-a', 'Session A');
  insertSession.run('session-b', 'Session B');

  const insertBranch = db.prepare(`
    INSERT INTO branches (id, session_id, created_at)
    VALUES (?, ?, 2)
  `);
  insertBranch.run('branch-a', 'session-a');
  insertBranch.run('branch-b', 'session-b');

  const insertTurn = db.prepare(`
    INSERT INTO turns
      (id, session_id, branch_id, trigger_type, execution_profile, narrative_policy,
       status, user_input, started_at)
    VALUES (?, ?, ?, 'userMessage', 'chat', 'off', 'completed', '', 3)
  `);
  insertTurn.run('turn-a', 'session-a', 'branch-a');
  insertTurn.run('turn-b', 'session-b', 'branch-b');

  const insertMessage = db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, role, kind, blocks_json, created_at)
    VALUES (?, ?, ?, 'user', 'normal', ?, 4)
  `);
  insertMessage.run('message-a', 'session-a', 'turn-a', '"A"');
  insertMessage.run('message-b', 'session-b', 'turn-b', '"B"');

  const insertAgentRun = db.prepare(`
    INSERT INTO agent_runs
      (id, session_id, parent_turn_id, kind, status, created_at, updated_at)
    VALUES (?, ?, ?, 'subagent', 'running', 5, 5)
  `);
  insertAgentRun.run('run-a', 'session-a', 'turn-a');
  insertAgentRun.run('run-b', 'session-b', 'turn-b');
}

function insertDeletableTurnGraph(database: TestDatabase): void {
  const db = database.db;
  db.prepare(`
    INSERT INTO turns
      (id, session_id, branch_id, trigger_type, execution_profile, narrative_policy,
       status, user_input, started_at)
    VALUES ('turn-delete', 'session-a', 'branch-a', 'userMessage', 'chat', 'off', 'completed', '', 20)
  `).run();
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, role, kind, blocks_json, created_at)
    VALUES ('message-delete', 'session-a', 'turn-delete', 'user', 'normal', '"delete"', 21)
  `).run();
  db.prepare(`
    INSERT INTO session_notes (session_id, body, last_message_id, updated_at)
    VALUES ('session-a', '', 'message-delete', 21)
  `).run();
  db.prepare(`
    INSERT INTO pending_fragments
      (id, session_id, turn_id, role, content, at, created_at)
    VALUES ('fragment-delete', 'session-a', 'turn-delete', 'user', '', 21, 21)
  `).run();
  db.prepare(`
    INSERT INTO turn_audio_segments
      (id, turn_id, session_id, sentence_index, storage_path, mime_type,
       byte_size, text, created_at)
    VALUES ('audio-delete', 'turn-delete', 'session-a', 0, 'a.wav', 'audio/wav', 1, '', 21)
  `).run();
  db.prepare(`
    INSERT INTO turn_audio_merged
      (turn_id, session_id, storage_path, mime_type, byte_size, segment_count, created_at)
    VALUES ('turn-delete', 'session-a', 'm.wav', 'audio/wav', 1, 1, 21)
  `).run();
  db.prepare(`
    INSERT INTO turn_attachments
      (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
    VALUES ('attachment-delete', 'turn-delete', 'session-a', 'a.txt', 'text/plain', 1, 1, 'a.txt', 21)
  `).run();
  db.prepare(`
    INSERT INTO artifacts
      (id, session_id, turn_id, type, title, content, content_location,
       meta_json, created_at, updated_at)
    VALUES ('artifact-delete', 'session-a', 'turn-delete', 'text', 'A', '', 'inline', '{}', 21, 21)
  `).run();
  db.prepare(`
    INSERT INTO agent_runs
      (id, session_id, parent_turn_id, kind, status, created_at, updated_at)
    VALUES ('run-delete', 'session-a', 'turn-delete', 'subagent', 'running', 21, 21)
  `).run();
  db.prepare(`
    INSERT INTO agent_runs
      (id, session_id, parent_turn_id, parent_agent_run_id,
       kind, status, created_at, updated_at)
    VALUES ('run-child', 'session-a', 'turn-a', 'run-a', 'subagent', 'running', 21, 21)
  `).run();
  db.prepare(`
    INSERT INTO kb_activations
      (id, call_id, kb_id, asset_id, session_id, turn_id, created_at)
    VALUES ('kb-delete', 'call', 'kb', 'asset', 'session-a', 'turn-delete', 21)
  `).run();
}
