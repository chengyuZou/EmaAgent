import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageKind } from '../../index.js';
import { MessagesRepo } from '../../repos/data/messages.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('MessagesRepo 历史加载集成测试', () => {
  let database: TestDatabase;
  let repo: MessagesRepo;
  const sessionId = 'history-session';

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES (?, '历史测试', 'D:/work', 1, 1)
    `).run(sessionId);
    repo = new MessagesRepo(database.db);
  });

  afterEach(() => {
    database.close();
  });

  it('updateBlocks 覆盖 blocks_json 并返回受影响行数', () => {
    insertMessage('message-upd', 100);
    const changed = repo.updateBlocks('message-upd', '{"new":true}');
    expect(changed).toBe(1);
    expect(repo.findById('message-upd')!.blocks_json).toBe('{"new":true}');
    expect(repo.updateBlocks('missing', '{}')).toBe(0);
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

  it('再次摘要只覆盖旧 summary 时, 沿覆盖游标保留旧摘要之前写入的尾部', () => {
    insertMessage('covered-a', 10);
    insertMessage('covered-b', 20);
    insertMessage('retained-c', 30);
    insertMessage('retained-d', 40);
    insertMessage('summary-one', 50, 'summary', 'covered-b');
    insertMessage('summary-two', 60, 'summary', 'summary-one');

    expect(repo.listForSessionFromSummary(sessionId).map(row => row.id))
      .toEqual(['summary-two', 'retained-c', 'retained-d']);
  });

  it('再次摘要覆盖旧 summary 和一条尾部时, 不重放旧 summary', () => {
    insertMessage('covered-a', 10);
    insertMessage('covered-b', 20);
    insertMessage('retained-c', 30);
    insertMessage('retained-d', 40);
    insertMessage('summary-one', 50, 'summary', 'covered-b');
    insertMessage('summary-two', 60, 'summary', 'retained-c');

    expect(repo.listForSessionFromSummary(sessionId).map(row => row.id))
      .toEqual(['summary-two', 'retained-d']);
  });

  it('三层摘要指向摘要时追到原消息边界', () => {
    insertMessage('covered', 10);
    insertMessage('retained', 20);
    insertMessage('summary-one', 30, 'summary', 'covered');
    insertMessage('summary-two', 40, 'summary', 'summary-one');
    insertMessage('summary-three', 50, 'summary', 'summary-two');

    expect(repo.listForSessionFromSummary(sessionId).map(row => row.id))
      .toEqual(['summary-three', 'retained']);
  });

  function insertMessage(
    id: string,
    createdAt: number,
    kind: MessageKind = 'normal',
    summarizedThroughMessageId?: string,
  ): void {
    repo.insert({
      id,
      sessionId,
      role: 'user',
      kind,
      blocksJson: JSON.stringify(id),
      createdAt,
      ...(summarizedThroughMessageId ? { summarizedThroughMessageId } : {}),
    });
  }
});
