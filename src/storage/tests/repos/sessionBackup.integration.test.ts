// 验证 Session 备份读取器在单次事务内完整流出记录，并对不存在的 Session 返回 null。
import { afterEach, describe, expect, it } from 'vitest';
import {
  MessagesRepo,
  SessionBackupReader,
  SessionBackupRestorer,
  SessionsRepo,
  SubagentMessagesRepo,
  SubagentRunsRepo,
  SubagentsRepo,
  TurnsRepo,
} from '../../index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('SessionBackupReader', () => {
  let database: TestDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('按稳定顺序消费完整记录且不施加旧列表上限', () => {
    database = createTestDatabase();
    const sessions = new SessionsRepo(database.db);
    const turns = new TurnsRepo(database.db);
    sessions.insert({
      id: 'session-backup',
      title: 'backup',
      cwd: 'D:/work',
      sessionMode: 'work',
      narrativePolicy: 'auto',
      createdAt: 1,
      updatedAt: 1,
    });
    for (let index = 0; index < 12; index += 1) {
      turns.insert({
        id: `turn-${String(index).padStart(2, '0')}`,
        sessionId: 'session-backup',
        triggerType: 'userMessage',
        sessionMode: 'work',
        narrativePolicy: 'auto',
        ttsEnabled: false,
        createdAt: index,
      });
    }
    const result = new SessionBackupReader(database.db).readSession(
      'session-backup',
      rows => ({
        sessionId: rows.session.id,
        turnIds: [...rows.turns].map(turn => turn.id),
        emptyMessages: [...rows.messages],
      }),
    );

    expect(result?.sessionId).toBe('session-backup');
    expect(result?.turnIds).toEqual(
      Array.from({ length: 12 }, (_, index) => `turn-${String(index).padStart(2, '0')}`),
    );
    expect(result?.emptyMessages).toEqual([]);
  });

  it('不存在的 Session 不构造空备份', () => {
    database = createTestDatabase();
    expect(
      new SessionBackupReader(database.db).readSession('missing', () => true),
    ).toBeNull();
  });

  it('导出→恢复保留 summary 覆盖游标，按游标切边界得到 [Summary, B]', () => {
    database = createTestDatabase();
    const sessions = new SessionsRepo(database.db);
    sessions.insert({
      id: 'session-cursor',
      title: 'cursor',
      cwd: 'D:/work',
      sessionMode: 'work',
      narrativePolicy: 'auto',
      createdAt: 1,
      updatedAt: 1,
    });
    database.db.prepare(`
      INSERT INTO turns
        (id, session_id, trigger_type, session_mode, narrative_policy, status, created_at)
      VALUES (?, ?, 'userMessage', 'work', 'auto', 'completed', ?)
    `).run('turn-1', 'session-cursor', 10);

    const insertMessage = database.db.prepare(`
      INSERT INTO messages
        (id, session_id, turn_id, role, kind, blocks_json, created_at, summarized_through_message_id)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
    `);
    // 旧消息 A、Summary(cursor=A)、未覆盖消息 B。
    insertMessage.run('msg-a', 'session-cursor', 'turn-1', 'normal', '"old A"', 10, null);
    insertMessage.run('msg-summary', 'session-cursor', 'turn-1', 'summary', '"summary"', 30, 'msg-a');
    database.db.prepare('UPDATE messages SET summary_saved_tokens = ? WHERE id = ?')
      .run(12_345, 'msg-summary');
    database.db.prepare(`
      INSERT INTO goals (
        id, session_id, objective, feedback, status, version, reason, error,
        created_at, updated_at, completed_at
      ) VALUES ('goal-1', 'session-cursor', '目标原文', '阶段反馈', 'completed', 3,
        'succeeded', NULL, 4, 8, 8)
    `).run();
    insertMessage.run('msg-b', 'session-cursor', 'turn-1', 'normal', '"B"', 20, null);
    const runs = new SubagentRunsRepo(database.db);
    const identities = new SubagentsRepo(database.db);
    database.db.transaction(() => {
      identities.insert({ id: 'subagent-1', sessionId: 'session-cursor', title: '调查', description: '持久化调查', createdAt: 11 });
      return runs.insert({ id: 'run-1', subagentId: 'subagent-1', parentToolCallId: 'call-subagent-1', contextMode: 'fork', createdAt: 11 });
    })();
    runs.setRunConfiguration('run-1', {
      providerId: 'provider-1', modelId: 'model-1', protocol: 'openai-llm',
      permissionMode: 'default', reasoningEffort: 'medium',
    }, 11);
    const subagentMessages = new SubagentMessagesRepo(database.db);
    subagentMessages.insert({
      id: 'subagent-assistant', subagentId: 'subagent-1', runId: null, role: 'assistant',
      blocksJson: '[{"type":"text","text":"result"}]', interrupted: true, createdAt: 12,
      providerId: 'parent-provider', modelId: 'parent-model', protocol: 'anthropic-llm',
    });
    subagentMessages.insert({
      id: 'subagent-summary', subagentId: 'subagent-1', runId: 'run-1', role: 'user', kind: 'summary',
      blocksJson: '"summary"', summarizedThroughMessageId: 'subagent-assistant', savedTokens: 456, createdAt: 13,
    });

    runs.cancelRun('run-1', 'first stopped', 11);
    // 相同毫秒的后一次 Run, 导出顺序必须保留最近一次的含义.
    runs.startRun({ id: 'run-0', subagentId: 'subagent-1', contextMode: 'fork', createdAt: 11 });
    runs.setRunConfiguration('run-0', {
      providerId: 'provider-2', modelId: 'model-2', protocol: 'openai-llm',
      permissionMode: 'acceptEdits', reasoningEffort: 'high',
    }, 11);
    subagentMessages.insert({
      id: 'subagent-own', subagentId: 'subagent-1', runId: 'run-0', role: 'assistant',
      blocksJson: '[{"type":"reasoning","id":"native-item","encryptedContent":"encrypted"}]', createdAt: 14,
    });
    runs.completeRun('run-0', {
      iterations: 2, toolCallCount: 3, inputTokens: 100, outputTokens: 20, finalText: 'done',
    }, 15);

    const restored = new SessionBackupReader(database.db).readSession(
      'session-cursor',
      rows => ({
        session: { ...rows.session, id: 'session-restored' },
        turns: [...rows.turns],
        messages: [...rows.messages],
        tasks: [...rows.tasks],
        goals: [...rows.goals],
        subagents: [...rows.subagents],
        subagentRuns: [...rows.subagentRuns],
        subagentMessages: [...rows.subagentMessages],
        toolExecutions: [...rows.toolExecutions],
        backgroundProcesses: [...rows.backgroundProcesses],
        attachmentImages: [...rows.attachmentImages],
        attachmentPastedTexts: [...rows.attachmentPastedTexts],
        speechOutputs: [...rows.speechOutputs],
        usageRecords: [...rows.usageRecords],
      }),
    );
    expect(restored).not.toBeNull();

    // restorer 保留 turn/message 原 id（只换 session_id），先删源 Session 避免 UNIQUE 冲突。
    database.db.prepare('DELETE FROM sessions WHERE id = ?').run('session-cursor');
    new SessionBackupRestorer(database.db).restoreSession(restored!);

    // 恢复后游标保留：按游标切边界得到 [Summary, B]。
    const history = new MessagesRepo(database.db)
      .listForSessionFromSummary('session-restored');
    expect(history.map((message) => message.id)).toEqual(['msg-summary', 'msg-b']);
    expect(history[0]?.summary_saved_tokens).toBe(12_345);
    expect(database.db.prepare('SELECT * FROM goals WHERE id = ?').get('goal-1')).toMatchObject({
      session_id: 'session-restored',
      objective: '目标原文',
      feedback: '阶段反馈',
      status: 'completed',
      version: 3,
      reason: 'succeeded',
      completed_at: 8,
    });
    expect(new SubagentMessagesRepo(database.db).listAllForSubagent('subagent-1')).toMatchObject([
      {
        id: 'subagent-assistant', run_id: null, role: 'assistant', kind: 'normal', interrupted: 1,
        provider_id: 'parent-provider', model_id: 'parent-model', protocol: 'anthropic-llm',
      },
      {
        id: 'subagent-summary', run_id: 'run-1', role: 'user', kind: 'summary',
        summarized_through_message_id: 'subagent-assistant', summary_saved_tokens: 456,
      },
      { id: 'subagent-own', run_id: 'run-0', provider_id: 'provider-2', model_id: 'model-2', protocol: 'openai-llm' },
    ]);
    const restoredRuns = new SubagentRunsRepo(database.db);
    expect(restoredRuns.listForSubagent('subagent-1').items).toMatchObject([
      { id: 'run-1', parent_tool_call_id: 'call-subagent-1', subagent_id: 'subagent-1', status: 'cancelled', created_at: 11, permission_mode: 'default', reasoning_effort: 'medium', completed_at: 11 },
      { id: 'run-0', parent_tool_call_id: null, subagent_id: 'subagent-1', status: 'completed', created_at: 11, permission_mode: 'acceptEdits', reasoning_effort: 'high', completed_at: 15 },
    ]);
    expect(restoredRuns.findLatestRun('subagent-1')?.id).toBe('run-0');
    const completedRun = restoredRuns.findById('run-0')!;
    expect(completedRun.completed_at! - completedRun.created_at).toBe(4);
    expect(completedRun).not.toHaveProperty('duration_ms');
    const restoredIdentity = new SubagentsRepo(database.db).findById('subagent-1');
    expect(restoredIdentity).toEqual({
      id: 'subagent-1', session_id: 'session-restored', title: '调查', description: '持久化调查',
      provider_id: 'provider-2', model_id: 'model-2', protocol: 'openai-llm',
      permission_mode: 'acceptEdits', reasoning_effort: 'high', status: 'completed',
      created_at: 11, updated_at: 15,
    });
    expect(restoredIdentity).not.toHaveProperty('input_tokens');
    expect(restoredIdentity).not.toHaveProperty('duration_ms');
    expect(new SubagentMessagesRepo(database.db).listForSubagentFromSummary('subagent-1').map(row => row.id))
      .toEqual(['subagent-summary', 'subagent-own']);
    expect(database.db.prepare('SELECT provider_id, model_id, protocol FROM subagent_messages WHERE id = ?').get('subagent-own'))
      .toEqual({ provider_id: null, model_id: null, protocol: null });
    expect(database.db.pragma('foreign_key_check')).toEqual([]);
  });
});
