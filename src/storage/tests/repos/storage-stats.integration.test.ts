// 测试 Session 统计与备份恢复会完整保留归属和执行字段。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionStatsRepo,
  type SessionRestorePayload,
} from '../../repos/data/storage-stats.js';
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

  it('restores turns and messages while preserving ownership', () => {
    const payload = restorePayload();

    repo.restoreRows(payload);

    const turns = database.db.prepare(`
      SELECT id FROM turns WHERE session_id = ? ORDER BY id
    `).all(payload.session.id);
    expect(turns).toEqual([
      { id: 'turn-child' },
      { id: 'turn-root' },
    ]);

    expect(database.db.pragma('foreign_key_check')).toEqual([]);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM message_search_documents WHERE session_id = ?',
    ).pluck().get(payload.session.id)).toBe(2);
  });

  it('rejects cross-session ownership before writing any rows', () => {
    const payload = restorePayload();
    payload.turns[0]!.sessionId = 'another-session';

    expect(() => repo.restoreRows(payload)).toThrow(/属于 Session another-session/);
    expect(sessionCount(payload.session.id)).toBe(0);
  });

  it('rolls back the whole restore when a global child id conflicts', () => {
    insertExistingTurn('turn-root');
    const payload = restorePayload();

    expect(() => repo.restoreRows(payload)).toThrow();

    expect(sessionCount(payload.session.id)).toBe(0);
    expect(database.db.prepare(
      'SELECT COUNT(*) FROM messages WHERE session_id = ?',
    ).pluck().get(payload.session.id)).toBe(0);
  });

  it('restores dependent rows and preserves AgentRun state', () => {
    const payload = restorePayload();
    payload.tasks.push(
      {
        id: 'task-1',
        session_id: payload.session.id,
        display_number: 1,
        subject: 'Prepare',
        description: 'Prepare the input',
        active_form: null,
        status: 'completed',
        created_by_turn_id: 'turn-root',
        completed_by_turn_id: 'turn-root',
        version: 1,
        created_at: 100,
        updated_at: 110,
        completed_at: 110,
      },
      {
        id: 'task-2',
        session_id: payload.session.id,
        display_number: 2,
        subject: 'Execute',
        description: 'Execute the work',
        active_form: 'Executing',
        status: 'pending',
        created_by_turn_id: 'turn-child',
        completed_by_turn_id: null,
        version: 0,
        created_at: 140,
        updated_at: 140,
        completed_at: null,
      },
    );
    payload.taskDependencies.push({
      session_id: payload.session.id,
      blocker_task_id: 'task-1',
      blocked_task_id: 'task-2',
      created_at: 145,
    });
    payload.audio.push({
      turnId: 'turn-child', sessionId: payload.session.id, storagePath: 'audio/turn-child.wav',
      mimeType: 'audio/wav', byteSize: 128, durationMs: 500, segmentCount: 1, createdAt: 150,
    });
    payload.attachments.push({
      id: 'attachment-1', turnId: 'turn-child', kind: 'file', name: 'note.txt', mime: 'text/plain',
      byteSize: 4, sourceModifiedAt: 1, sourcePath: 'attachments/note.txt',
      imagePath: null, imageByteSize: null, createdAt: 150,
    });
    payload.agentRuns.push({
      id: 'run-1',
      session_id: payload.session.id,
      parent_turn_id: 'turn-child',
      parent_agent_run_id: null,
      task_id: 'task-2',
      kind: 'subagent',
      purpose: 'test',
      provider_config_id: null,
      model_id: null,
      status: 'completed',
      error: null,
      iterations: 2,
      tool_call_count: 1,
      input_tokens: 30,
      output_tokens: 40,
      output_excerpt: 'done',
      version: 7,
      created_at: 150,
      updated_at: 160,
      completed_at: 160,
    });
    payload.agentRunMessages.push({
      id: 'run-message-1', agent_run_id: 'run-1', role: 'assistant',
      content_json: JSON.stringify({ text: '等待用户' }), created_at: 155,
    });
    payload.memoryState = {
      session_id: payload.session.id, surfaced_json: '{}', overrides_json: '{}',
    };
    payload.kbActivations.push({
      id: 'activation-1', call_id: 'call-1', kb_id: 'kb-1', asset_id: 'asset-1',
      session_id: payload.session.id, turn_id: 'turn-child', created_at: 150,
    });
    payload.usageRecords.push({
      id: 'usage-1', session_id: payload.session.id, turn_id: 'turn-child',
      provider_id: 'provider-1', model_id: 'model-1', capability: 'llm', status: 'completed',
      input_tokens: 30, output_tokens: 40, cache_read_input_tokens: null,
      cache_write_input_tokens: null, quantity: null, unit: null,
      duration_ms: 500, error_code: null, created_at: 150,
    });
    payload.notes = { body: 'session notes', tokensAtLastUpdate: 3, updatedAt: 160 };

    repo.restoreRows(payload);

    const run = database.db.prepare(`
      SELECT status, version
      FROM agent_runs WHERE id = 'run-1'
    `).get() as {
      status: string;
      version: number;
    };
    expect(run).toEqual({
      status: 'completed',
      version: 7,
    });
    expect(repo.listAgentRuns(payload.session.id)).toEqual([
      expect.objectContaining({
        id: 'run-1',
        task_id: 'task-2',
        status: 'completed',
        version: 7,
      }),
    ]);
    expect(repo.listTasks(payload.session.id)).toEqual([
      expect.objectContaining({ id: 'task-1', status: 'completed' }),
      expect.objectContaining({ id: 'task-2', status: 'pending' }),
    ]);
    expect(repo.listTaskDependencies(payload.session.id)).toEqual([
      expect.objectContaining({
        blocker_task_id: 'task-1',
        blocked_task_id: 'task-2',
      }),
    ]);
    expect(database.db.prepare(`
      SELECT sequence FROM agent_run_messages WHERE id = 'run-message-1'
    `).pluck().get()).toBe(1);

    for (const table of [
      'speech_outputs', 'attachments', 'agent_run_messages',
      'memory_session_state', 'kb_activations', 'usage_records', 'session_notes',
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(1);
    }
  });

  it('restores a forked Session without requiring its source Session backup', () => {
    const payload = restorePayload();
    payload.session.forkedFromSessionId = 'source-session-not-in-backup';

    repo.restoreRows(payload);

    expect(database.db.prepare(
      'SELECT forked_from_session_id FROM sessions WHERE id = ?',
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
      INSERT INTO turns
        (id, session_id, trigger_type, execution_profile, narrative_policy, status, created_at)
      VALUES (?, 'existing-session', 'userMessage', 'chat', 'off', 'completed', 1)
    `).run(turnId);
  }
});

function restorePayload(): SessionRestorePayload {
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
      forkedFromSessionId: null,
      forkedFromTurnId: null,
      executionProfile: 'chat',
      narrativePolicy: 'off',
    },
    turns: [
      {
        id: 'turn-root',
        sessionId: 'restored-session',
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        providerConfigId: null,
        modelId: null,
        status: 'completed',
        createdAt: 100,
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
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        providerConfigId: null,
        modelId: null,
        status: 'completed',
        createdAt: 130,
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
    audio: [],
    attachments: [],
    tasks: [],
    taskDependencies: [],
    agentRuns: [],
    agentRunMessages: [],
    memoryState: null,
    kbActivations: [],
    usageRecords: [],
    notes: null,
  };
}
