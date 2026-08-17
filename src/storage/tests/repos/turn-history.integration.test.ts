// 测试 Turn 按 created_at 稳定分页、锚点窗口和索引预览改读首条 User Message。
import { describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { MessagesRepo } from '../../repos/data/messages.js';
import { SessionsRepo } from '../../repos/data/sessions.js';
import { TurnsRepo } from '../../repos/data/turns.js';

function createFixture() {
  const database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  const sessions = new SessionsRepo(database.sqlite);
  const turns = new TurnsRepo(database.sqlite);
  const messages = new MessagesRepo(database.sqlite);
  const sessionId = 'session-history';
  sessions.insert({
    id: sessionId,
    title: 'history',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  });
  return { database, turns, messages, sessionId };
}

describe('Turn 历史读取', () => {
  it('同时间戳分页依靠 id 稳定覆盖全部 Turn', () => {
    const { turns, sessionId } = createFixture();
    for (const id of ['turn-a', 'turn-b', 'turn-c']) {
      turns.insert({
        id,
        sessionId,
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        createdAt: 10,
      });
    }

    const first = turns.listForSessionPage(sessionId, undefined, 2);
    const second = turns.listForSessionPage(sessionId, first.nextCursor ?? undefined, 2);

    expect(first.rows.map((row) => row.id)).toEqual(['turn-c', 'turn-b']);
    expect(second.rows.map((row) => row.id)).toEqual(['turn-a']);
  });

  it('锚点窗口按旧到新返回，并只读取窗口内消息', () => {
    const { turns, messages, sessionId } = createFixture();
    for (let index = 0; index < 5; index++) {
      const turnId = `turn-${index}`;
      turns.insert({
        id: turnId,
        sessionId,
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        createdAt: index + 1,
      });
      messages.insert({
        id: `message-${index}`,
        sessionId,
        turnId,
        role: 'user',
        blocksJson: JSON.stringify(`message ${index}`),
        createdAt: index + 1,
      });
    }

    const window = turns.listWindowAround(sessionId, 'turn-2', 1, 1);
    expect(window?.rows.map((row) => row.id)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(window).toMatchObject({ hasOlder: true, hasNewer: true });

    const rows = messages.listForTurns(
      sessionId,
      window!.rows.map((row) => row.id),
    );
    expect(rows.map((row) => row.id)).toEqual(['message-1', 'message-2', 'message-3']);
  });

  it('Turn 索引预览取自首条 User Message，无消息时为空串', () => {
    const { turns, messages, sessionId } = createFixture();
    turns.insert({
      id: 'turn-a',
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 1,
    });
    messages.insert({
      id: 'message-user',
      sessionId,
      turnId: 'turn-a',
      role: 'user',
      kind: 'normal',
      blocksJson: JSON.stringify([{ type: 'text', text: '用户首条输入' }]),
      createdAt: 1,
    });
    messages.insert({
      id: 'message-assistant',
      sessionId,
      turnId: 'turn-a',
      role: 'assistant',
      blocksJson: JSON.stringify([{ type: 'text', text: '助手回复不应作预览' }]),
      createdAt: 2,
    });
    turns.insert({
      id: 'turn-b',
      sessionId,
      triggerType: 'backgroundProcessCompleted',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 3,
    });

    const page = turns.listForSessionPage(sessionId, undefined, 10);
    expect(page.rows.map((row) => [row.id, row.preview])).toEqual([
      ['turn-b', ''],
      ['turn-a', '用户首条输入'],
    ]);
    expect(page.rows[0]).toMatchObject({ trigger_type: 'backgroundProcessCompleted' });
  });

  it('模型冻结成对写入，残缺写入被数据库拒绝', () => {
    const { database, turns, sessionId } = createFixture();
    turns.insert({
      id: 'turn-a',
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 1,
    });
    turns.setModel('turn-a', 'provider-config-1', 'model-1');
    expect(turns.findById('turn-a')).toMatchObject({
      provider_id: 'provider-config-1',
      model_id: 'model-1',
    });

    expect(() => database.sqlite.prepare(`
      UPDATE turns SET model_id = NULL WHERE id = 'turn-a'
    `).run()).toThrow(/both provider and model/);
  });

  it('Turn 索引分页使用 Session 最新 Turn 索引', () => {
    const { database } = createFixture();
    const plan = database.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM turns
      WHERE session_id = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all('session-history', 10, 10, 'turn-z', 20) as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes('idx_turns_session_latest'))).toBe(true);
  });
});
