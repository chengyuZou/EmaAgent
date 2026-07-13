import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionStatsRepo,
  SessionRestoreValidationError,
  type SessionRestorePayload,
} from '../../src/repos/storage-stats.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('SessionStatsRepo restore integration', () => {
  let database: TestDatabase;
  let repo: SessionStatsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    repo = new SessionStatsRepo(database.db);
  });

  afterEach(() => {
    database.close();
  });

  it('restores a multi-level branch graph independent of payload order', () => {
    const payload = branchedPayload();

    repo.restoreRows(payload);

    const session = database.db.prepare(
      'SELECT active_branch_id FROM sessions WHERE id = ?',
    ).get(payload.session.id) as { active_branch_id: string | null };
    expect(session.active_branch_id).toBe('branch-child');

    const branches = database.db.prepare(`
      SELECT id, parent_branch_id, fork_from_turn_id
      FROM branches
      WHERE session_id = ?
      ORDER BY id
    `).all(payload.session.id);
    expect(branches).toEqual([
      { id: 'branch-child', parent_branch_id: 'branch-root', fork_from_turn_id: 'turn-root' },
      { id: 'branch-root', parent_branch_id: null, fork_from_turn_id: null },
    ]);

    const turns = database.db.prepare(`
      SELECT id, branch_id FROM turns WHERE session_id = ? ORDER BY id
    `).all(payload.session.id);
    expect(turns).toEqual([
      { id: 'turn-child', branch_id: 'branch-child' },
      { id: 'turn-root', branch_id: 'branch-root' },
    ]);

    expect(database.db.pragma('foreign_key_check')).toEqual([]);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM message_search_documents WHERE session_id = ?',
    ).pluck().get(payload.session.id)).toBe(2);
  });

  it('rejects a missing fork Turn before writing any rows', () => {
    const payload = branchedPayload();
    payload.branches[0]!.fork_from_turn_id = 'missing-turn';

    expect(() => repo.restoreRows(payload)).toThrow(SessionRestoreValidationError);
    expect(sessionCount(payload.session.id)).toBe(0);
  });

  it('rejects cross-session ownership before writing any rows', () => {
    const payload = branchedPayload();
    payload.turns[0]!.sessionId = 'another-session';

    expect(() => repo.restoreRows(payload)).toThrow(/属于 Session another-session/);
    expect(sessionCount(payload.session.id)).toBe(0);
  });

  it('rejects a cyclic branch parent graph before writing any rows', () => {
    const payload = branchedPayload();
    payload.branches[1]!.parent_branch_id = 'branch-child';

    expect(() => repo.restoreRows(payload)).toThrow(/存在循环/);
    expect(sessionCount(payload.session.id)).toBe(0);
  });

  it('rolls back the whole restore when a global child id conflicts', () => {
    insertExistingTurn('turn-root');
    const payload = branchedPayload();

    expect(() => repo.restoreRows(payload)).toThrow();

    expect(sessionCount(payload.session.id)).toBe(0);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM branches WHERE session_id = ?',
    ).pluck().get(payload.session.id)).toBe(0);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM messages WHERE session_id = ?',
    ).pluck().get(payload.session.id)).toBe(0);
  });

  it('restores dependent rows and preserves waiting-user task state', () => {
    const payload = branchedPayload();
    payload.artifacts.push({
      id: 'artifact-1', sessionId: payload.session.id, turnId: 'turn-child',
      type: 'text', title: 'Artifact', contentLocation: 'inline', content: 'body',
      contentPath: null, createdAt: 150, appliedAt: null, rejectedAt: null,
    });
    payload.audio.push({
      turnId: 'turn-child', sessionId: payload.session.id, storagePath: 'audio/turn-child.wav',
      mimeType: 'audio/wav', byteSize: 128, durationMs: 500, segmentCount: 1, createdAt: 150,
    });
    payload.attachments.push({
      id: 'attachment-1', turnId: 'turn-child', name: 'note.txt', mime: 'text/plain',
      size: 4, mtime: 1, localPath: 'attachments/note.txt', createdAt: 150,
    });
    payload.agentTasks.push({
      id: 'task-1', session_id: payload.session.id, turn_id: 'turn-child', parent_id: null,
      status: 'waiting_user', pending_prompt_id: 'prompt-1',
      pending_questions_json: JSON.stringify([{ id: 'question-1', prompt: '继续吗？' }]),
      error: null, iterations: 2, input_tokens: 30, output_tokens: 40,
      created_at: 150, updated_at: 160,
    });
    payload.agentTaskMessages.push({
      id: 'task-message-1', task_id: 'task-1', role: 'assistant',
      content_json: JSON.stringify({ text: '等待用户' }), created_at: 155,
    });
    payload.memoryState = {
      session_id: payload.session.id, surfaced_json: '{}', overrides_json: '{}',
    };
    payload.kbActivations.push({
      id: 'activation-1', call_id: 'call-1', kb_id: 'kb-1', asset_id: 'asset-1',
      session_id: payload.session.id, turn_id: 'turn-child', created_at: 150,
    });
    payload.turnUsage.push({
      turn_id: 'turn-child', llm_provider: 'openai-llm', model_id: 'model-1',
      input_tokens: 30, output_tokens: 40, cost_usd: 0.01, duration_ms: 500, created_at: 150,
    });
    payload.notes = { body: 'session notes', tokensAtLastUpdate: 3, updatedAt: 160 };

    repo.restoreRows(payload);

    const task = database.db.prepare(`
      SELECT status, pending_prompt_id, pending_questions_json
      FROM agent_tasks WHERE id = 'task-1'
    `).get() as {
      status: string;
      pending_prompt_id: string | null;
      pending_questions_json: string | null;
    };
    expect(task).toEqual({
      status: 'waiting_user',
      pending_prompt_id: 'prompt-1',
      pending_questions_json: JSON.stringify([{ id: 'question-1', prompt: '继续吗？' }]),
    });

    for (const table of [
      'artifacts', 'turn_audio_merged', 'turn_attachments', 'agent_task_messages',
      'memory_session_state', 'kb_activations', 'turn_usage', 'session_notes',
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(1);
    }
  });

  it('restores a forked Session without requiring its source Session backup', () => {
    const payload = branchedPayload();
    payload.session.parentSessionId = 'source-session-not-in-backup';

    repo.restoreRows(payload);

    expect(database.db.prepare(
      'SELECT parent_session_id FROM sessions WHERE id = ?',
    ).pluck().get(payload.session.id)).toBeNull();
  });

  function sessionCount(sessionId: string): number {
    return database.db.prepare(
      'SELECT COUNT(*) FROM sessions WHERE id = ?',
    ).pluck().get(sessionId) as number;
  }

  function insertExistingTurn(turnId: string): void {
    database.db.prepare(`
      INSERT INTO sessions (id, title, last_activity_at, created_at, updated_at)
      VALUES ('existing-session', 'Existing', 1, 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns (id, session_id, mode, status, user_input, started_at)
      VALUES (?, 'existing-session', 'chat', 'completed', '', 1)
    `).run(turnId);
  }
});

function branchedPayload(): SessionRestorePayload {
  return {
    session: {
      id: 'restored-session',
      title: 'Restored',
      workspaceRoot: null,
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      archivedAt: null,
      pinned: false,
      pinnedAt: null,
      groupLabel: null,
      parentSessionId: null,
      lastMode: 'chat',
      activeBranchId: 'branch-child',
    },
    // 故意 child 在 root 前，证明恢复不依赖 payload 顺序。
    branches: [
      {
        id: 'branch-child',
        session_id: 'restored-session',
        parent_branch_id: 'branch-root',
        fork_from_turn_id: 'turn-root',
        created_at: 120,
      },
      {
        id: 'branch-root',
        session_id: 'restored-session',
        parent_branch_id: null,
        fork_from_turn_id: null,
        created_at: 100,
      },
    ],
    turns: [
      {
        id: 'turn-root',
        sessionId: 'restored-session',
        branchId: 'branch-root',
        mode: 'chat',
        status: 'completed',
        userInput: 'root',
        startedAt: 100,
        completedAt: 110,
        errorCode: null,
        errorMessage: null,
        iterations: 1,
        usageInputTokens: 10,
        usageOutputTokens: 20,
      },
      {
        id: 'turn-child',
        sessionId: 'restored-session',
        branchId: 'branch-child',
        mode: 'chat',
        status: 'completed',
        userInput: 'child',
        startedAt: 130,
        completedAt: 140,
        errorCode: null,
        errorMessage: null,
        iterations: 1,
        usageInputTokens: 11,
        usageOutputTokens: 21,
      },
    ],
    messages: [
      {
        id: 'message-root',
        sessionId: 'restored-session',
        turnId: 'turn-root',
        role: 'user',
        kind: 'normal',
        blocksJson: JSON.stringify('root message'),
        interrupted: false,
        createdAt: 101,
      },
      {
        id: 'message-child',
        sessionId: 'restored-session',
        turnId: 'turn-child',
        role: 'assistant',
        kind: 'normal',
        blocksJson: JSON.stringify([{ type: 'text', text: 'child message' }]),
        interrupted: false,
        createdAt: 131,
      },
    ],
    artifacts: [],
    audio: [],
    attachments: [],
    agentTasks: [],
    agentTaskMessages: [],
    memoryState: null,
    kbActivations: [],
    turnUsage: [],
    notes: null,
  };
}
