// 测试 Turn 稳定分页、锚点窗口和对应消息读取不会丢行或重复。
import { describe, expect, it } from 'vitest';
import { asMessageId, asSessionId, asTurnId } from '@ema-agent/ids';
import { Database } from '../../database.js';
import { MessagesRepo } from '../../repos/messages.js';
import { SessionsRepo } from '../../repos/sessions.js';
import { TurnsRepo } from '../../repos/turns.js';

function createFixture() {
  const database = new Database({ memory: true, kind: 'data' });
  database.migrate();
  const sessions = new SessionsRepo(database.sqlite);
  const turns = new TurnsRepo(database.sqlite);
  const messages = new MessagesRepo(database.sqlite);
  const sessionId = asSessionId('session-history');
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
        id: asTurnId(id),
        sessionId,
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        userInput: id,
        startedAt: 10,
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
      const turnId = asTurnId(`turn-${index}`);
      turns.insert({
        id: turnId,
        sessionId,
        triggerType: 'userMessage',
        executionProfile: 'chat',
        narrativePolicy: 'off',
        userInput: `turn ${index}`,
        startedAt: index + 1,
      });
      messages.insert({
        id: asMessageId(`message-${index}`),
        sessionId,
        turnId,
        role: 'user',
        blocksJson: JSON.stringify(`message ${index}`),
        createdAt: index + 1,
      });
    }

    const window = turns.listWindowAround(sessionId, asTurnId('turn-2'), 1, 1);
    expect(window?.rows.map((row) => row.id)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(window).toMatchObject({ hasOlder: true, hasNewer: true });

    const rows = messages.listForTurns(
      sessionId,
      window!.rows.map((row) => asTurnId(row.id)),
    );
    expect(rows.map((row) => row.id)).toEqual(['message-1', 'message-2', 'message-3']);
  });

  it('Turn 索引分页使用 Session 最新 Turn 索引', () => {
    const { database } = createFixture();
    const plan = database.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM turns
      WHERE session_id = ?
        AND (started_at < ? OR (started_at = ? AND id < ?))
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all('session-history', 10, 10, 'turn-z', 20) as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes('idx_turns_session_latest'))).toBe(true);
  });
});
