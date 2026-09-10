// 测试 Turn 导航与 Message 正文各自按稳定游标读取，并用 Message 锚点连接两者。
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
    const { turns, messages, sessionId } = createFixture();
    for (const id of ['turn-a', 'turn-b', 'turn-c']) {
      turns.insert({
        id,
        sessionId,
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        createdAt: 10,
      });
      messages.insert({
        id: `message-${id}`,
        sessionId,
        turnId: id,
        role: 'user',
        blocksJson: JSON.stringify(id),
        createdAt: 10,
      });
    }

    const first = turns.listForSessionPage(sessionId, undefined, 2);
    const second = turns.listForSessionPage(sessionId, first.nextCursor ?? undefined, 2);

    expect(first.rows.map((row) => row.id)).toEqual(['turn-c', 'turn-b']);
    expect(second.rows.map((row) => row.id)).toEqual(['turn-a']);
  });

  it('Message 同时间戳分页依靠 id 稳定覆盖全部正文', () => {
    const { messages, sessionId } = createFixture();
    for (const id of ['message-a', 'message-b', 'message-c']) {
      messages.insert({
        id,
        sessionId,
        role: 'user',
        blocksJson: JSON.stringify(id),
        createdAt: 10,
      });
    }

    const first = messages.listPage(sessionId, undefined, 2);
    const second = messages.listPage(sessionId, first.nextCursor ?? undefined, 2);

    expect(first.rows.map((row) => row.id)).toEqual(['message-c', 'message-b']);
    expect(second.rows.map((row) => row.id)).toEqual(['message-a']);
  });

  it('Message 锚点窗口按旧到新返回并报告两侧缺口', () => {
    const { messages, sessionId } = createFixture();
    for (let index = 0; index < 5; index++) {
      messages.insert({
        id: `message-${index}`,
        sessionId,
        role: 'user',
        blocksJson: JSON.stringify(`message ${index}`),
        createdAt: index + 1,
      });
    }

    const window = messages.listWindowAround(sessionId, 'message-2', 1, 1);
    expect(window?.rows.map((row) => row.id)).toEqual(['message-1', 'message-2', 'message-3']);
    expect(window).toMatchObject({ hasOlder: true, hasNewer: true });
  });

  it('Turn 索引带首条 Message 锚点，并排除没有 Message 的 Turn', () => {
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
      id: 'message-reminder',
      sessionId,
      turnId: 'turn-a',
      role: 'user',
      kind: 'reminder',
      blocksJson: JSON.stringify('内部提醒不能成为 History 导航锚点'),
      createdAt: 0,
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
      triggerType: 'sessionContinuation',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 3,
    });

    const page = turns.listForSessionPage(sessionId, undefined, 10);
    expect(page.rows.map((row) => [row.id, row.anchor_message_id, row.preview])).toEqual([
      ['turn-a', 'message-user', '用户首条输入'],
    ]);
  });

  it('模型冻结成对写入（含调用协议），残缺写入被数据库拒绝', () => {
    const { database, turns, sessionId } = createFixture();
    turns.insert({
      id: 'turn-a',
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 1,
    });
    turns.setModel('turn-a', 'provider-config-1', 'model-1', 'openai-chat');
    expect(turns.findById('turn-a')).toMatchObject({
      provider_id: 'provider-config-1',
      model_id: 'model-1',
      protocol: 'openai-chat',
    });

    expect(() => database.sqlite.prepare(`
      UPDATE turns SET model_id = NULL WHERE id = 'turn-a'
    `).run()).toThrow(/both provider and model/);
  });

  it('copyTurn 复制模型选择与调用协议', () => {
    const { turns, sessionId } = createFixture();
    turns.insert({
      id: 'turn-a',
      sessionId,
      triggerType: 'userMessage',
      executionProfile: 'chat',
      narrativePolicy: 'off',
      createdAt: 1,
    });
    turns.setModel('turn-a', 'provider-config-1', 'model-1', 'openai-chat');
    turns.copyTurn(turns.findById('turn-a')!, sessionId, 'turn-copy');
    expect(turns.findById('turn-copy')).toMatchObject({
      provider_id: 'provider-config-1',
      model_id: 'model-1',
      protocol: 'openai-chat',
    });
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
