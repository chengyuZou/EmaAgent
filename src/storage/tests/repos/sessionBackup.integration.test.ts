// 验证 Session 备份读取器在单次事务内完整流出记录，并对不存在的 Session 返回 null。
import { afterEach, describe, expect, it } from 'vitest';
import {
  MessagesRepo,
  SessionBackupReader,
  SessionBackupRestorer,
  SessionsRepo,
  SubagentMessagesRepo,
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
    insertMessage.run('msg-b', 'session-cursor', 'turn-1', 'normal', '"B"', 20, null);
    new SubagentsRepo(database.db).insert({
      id: 'subagent-1',
      sessionId: 'session-cursor',
      parentTurnId: 'turn-1',
      contextMode: 'subagent',
      createdAt: 11,
    });
    const subagentMessages = new SubagentMessagesRepo(database.db);
    subagentMessages.insert({
      id: 'subagent-assistant', subagentId: 'subagent-1', role: 'assistant',
      blocksJson: '[{"type":"text","text":"result"}]', interrupted: true, createdAt: 12,
    });
    subagentMessages.insert({
      id: 'subagent-summary', subagentId: 'subagent-1', role: 'user', kind: 'summary',
      blocksJson: '"summary"', summarizedThroughMessageId: 'subagent-assistant', createdAt: 13,
    });

    const restored = new SessionBackupReader(database.db).readSession(
      'session-cursor',
      rows => ({
        session: { ...rows.session, id: 'session-restored' },
        turns: [...rows.turns],
        messages: [...rows.messages],
        tasks: [...rows.tasks],
        subagents: [...rows.subagents],
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
    expect(new SubagentMessagesRepo(database.db).listAllForSubagent('subagent-1')).toMatchObject([
      { id: 'subagent-assistant', role: 'assistant', kind: 'normal', interrupted: 1, sequence: 1 },
      {
        id: 'subagent-summary', role: 'user', kind: 'summary', sequence: 2,
        summarized_through_message_id: 'subagent-assistant',
      },
    ]);
  });
});
