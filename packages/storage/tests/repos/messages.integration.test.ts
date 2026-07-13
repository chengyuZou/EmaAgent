import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asMessageId, asSessionId, type MessageKind } from '@ema-agent/contracts';
import { MessagesRepo } from '../../src/repos/messages.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('MessagesRepo 历史加载集成测试', () => {
  let database: TestDatabase;
  let repo: MessagesRepo;
  const sessionId = asSessionId('history-session');

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES (?, '历史测试', 1, 1)
    `).run(sessionId);
    repo = new MessagesRepo(database.db);
  });

  afterEach(() => {
    database.close();
  });

  it('没有 summary 时返回最新 N 条，并按稳定正序输出', () => {
    insertMessage('message-a', 100);
    insertMessage('message-b', 100);
    insertMessage('message-c', 100);
    insertMessage('message-d', 100);

    expect(repo.listForSessionFromSummary(sessionId, 2).map((row) => row.id))
      .toEqual(['message-c', 'message-d']);
  });

  it('始终保留最新 summary，并只返回它之后最新的剩余消息', () => {
    insertMessage('old-before-summary', 90);
    insertMessage('latest-summary', 100, 'summary');
    insertMessage('post-summary-old', 110);
    insertMessage('post-summary-new-a', 120);
    insertMessage('post-summary-new-b', 130);

    const rows = repo.listForSessionFromSummary(sessionId, 3);

    expect(rows.map((row) => row.id)).toEqual([
      'latest-summary',
      'post-summary-new-a',
      'post-summary-new-b',
    ]);
  });

  it('limit 为 1 时只返回最新 summary', () => {
    insertMessage('summary-a', 100, 'summary');
    insertMessage('summary-z', 100, 'summary');
    insertMessage('post-summary', 110);

    expect(repo.findLastSummary(sessionId)?.id).toBe('summary-z');
    expect(repo.listForSessionFromSummary(sessionId, 1).map((row) => row.id))
      .toEqual(['summary-z']);
  });

  function insertMessage(id: string, createdAt: number, kind: MessageKind = 'normal'): void {
    repo.insert({
      id: asMessageId(id),
      sessionId,
      role: 'user',
      kind,
      blocksJson: JSON.stringify(id),
      createdAt,
    });
  }
});
