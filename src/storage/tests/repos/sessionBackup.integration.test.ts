// 验证 Session 备份读取器在单次事务快照内完整流出记录，并对不存在的 Session 返回 null。
import { afterEach, describe, expect, it } from 'vitest';
import { SessionBackupReader, SessionsRepo, TurnsRepo } from '../../index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('SessionBackupReader', () => {
  let database: TestDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('按稳定顺序消费完整快照且不施加旧列表上限', () => {
    database = createTestDatabase();
    const sessions = new SessionsRepo(database.db);
    const turns = new TurnsRepo(database.db);
    sessions.insert({
      id: 'session-backup',
      title: 'backup',
      executionProfile: 'work',
      narrativePolicy: 'auto',
      createdAt: 1,
      updatedAt: 1,
    });
    for (let index = 0; index < 12; index += 1) {
      turns.insert({
        id: `turn-${String(index).padStart(2, '0')}`,
        sessionId: 'session-backup',
        triggerType: 'userMessage',
        executionProfile: 'work',
        narrativePolicy: 'auto',
        createdAt: index,
      });
    }

    const result = new SessionBackupReader(database.db).withSnapshot(
      'session-backup',
      snapshot => ({
        sessionId: snapshot.session.id,
        turnIds: [...snapshot.turns].map(turn => turn.id),
        emptyMessages: [...snapshot.messages],
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
      new SessionBackupReader(database.db).withSnapshot('missing', () => true),
    ).toBeNull();
  });
});
