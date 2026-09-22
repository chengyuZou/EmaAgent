// 测试 Turn 生命周期、单 Session 运行锁、取消信号、删除守卫、导航查询与最后一轮回滚。
import { describe, expect, it } from 'vitest';
import { Database, MessagesRepo, SessionsRepo } from '@ema-agent/storage';
import { SessionRunningRegistry } from '@ema-agent/session';
import { TurnStore } from '../turnStore.js';

let seq = 100;

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return { store: new TurnStore({ db, sessionRunning: new SessionRunningRegistry() }), db };
}

function insertSession(db: Database, id: string): string {
  new SessionsRepo(db.sqlite).insert({
    id: id,
    title: id,
    cwd: 'D:/work',
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

function startTurn(store: TurnStore, sessionId: string) {
  return store.startTurn({
    sessionId,
    triggerType: 'userMessage',
    sessionMode: 'chat',
    narrativePolicy: 'off',
  });
}

function insertMessage(
  db: Database,
  fixture: { sessionId: string; turnId: string; text: string; role?: 'user' | 'assistant' },
): void {
  new MessagesRepo(db.sqlite).insert({
    id: `message-${seq}`,
    sessionId: fixture.sessionId,
    turnId: fixture.turnId,
    role: fixture.role ?? 'user',
    blocksJson: JSON.stringify(fixture.text),
    createdAt: seq++,
  });
}

describe('TurnStore — 生命周期与运行锁', () => {
  it('Session 进入删除守卫后拒绝新 Turn，取消守卫后恢复', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    store.beginSessionDeletion(sessionId);
    expect(() => startTurn(store, sessionId)).toThrow('session_deleting');

    store.cancelSessionDeletion(sessionId);
    expect(() => startTurn(store, sessionId)).not.toThrow();
  });

  it('startTurn 创建 running Turn 并返回可触发的 AbortSignal', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn, signal } = startTurn(store, sessionId);

    expect(turn.status).toBe('running');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('同一 Session 已有运行中 Turn 时拒绝第二个（session_busy）', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    startTurn(store, sessionId);

    expect(() => startTurn(store, sessionId)).toThrow('session_busy');
  });

  it('不同 Session 可以同时运行 Turn', () => {
    const { store, db } = makeStore();
    const s1 = insertSession(db, 's1');
    const s2 = insertSession(db, 's2');

    expect(() => {
      startTurn(store, s1);
      startTurn(store, s2);
    }).not.toThrow();
  });

  it('终态提交即释放运行锁，新 Turn 可立即开始', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn } = startTurn(store, sessionId);
    store.setIterations(turn.id, 2);
    store.completeTurn(turn.id);

    const completed = store.getTurn(turn.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.iterations).toBe(2);
    expect(() => startTurn(store, sessionId)).not.toThrow();
  });

  it('abortTurn 触发信号并提交 aborted 终态', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn, signal } = startTurn(store, sessionId);
    store.abortTurn(sessionId, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)!.status).toBe('aborted');
  });

  it('requestAbort 只触发信号，不提前写 Turn 终态', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn, signal } = startTurn(store, sessionId);
    store.requestAbort(sessionId, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)!.status).toBe('running');
  });

  it('failTurn 提交 failed 终态与错误码', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn } = startTurn(store, sessionId);
    store.failTurn(turn.id, { errorCode: 'provider/timeout', errorMessage: 'LLM timed out' });

    const failed = store.getTurn(turn.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('provider/timeout');
    expect(failed.errorMessage).toBe('LLM timed out');
  });

  it('旧 Turn 的迟到 clearRunning 不会清掉后继 Turn', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn: first } = startTurn(store, sessionId);
    store.completeTurn(first.id);
    store.clearRunning(sessionId, first.id);

    const { turn: second } = startTurn(store, sessionId);
    store.clearRunning(sessionId, first.id);

    expect(store.getRunningTurn(sessionId)!.id).toBe(second.id);
    expect(() => startTurn(store, sessionId)).toThrow('session_busy');
  });

  it('getRunningTurn 在无运行 Turn 时返回 undefined', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    expect(store.getRunningTurn(sessionId)).toBeUndefined();
  });

  it('recoverStuckTurns 把遗留 running Turn 收口为 aborted', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    const { turn } = startTurn(store, sessionId);

    const { healed } = store.recoverStuckTurns();

    expect(healed).toBeGreaterThanOrEqual(1);
    expect(store.getTurn(turn.id)!.status).toBe('aborted');
  });
});

describe('TurnStore — 导航查询', () => {
  it('复合游标覆盖同一 Session 的全部 Turn 且不重复', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    const expected = new Set<string>();
    for (let index = 0; index < 5; index++) {
      const { turn } = startTurn(store, sessionId);
      expected.add(turn.id as string);
      store.completeTurn(turn.id);
      store.clearRunning(sessionId, turn.id);
    }

    const actual: string[] = [];
    let cursor: Parameters<typeof store.listTurnIdsPage>[1];
    do {
      const page = store.listTurnIdsPage(sessionId, cursor, 2);
      actual.push(...page.ids);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(new Set(actual)).toEqual(expected);
    expect(actual).toHaveLength(expected.size);
  });

  it('Turn 索引使用不透明游标分页，预览取自首条 User Message', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    for (let index = 0; index < 3; index++) {
      const { turn } = startTurn(store, sessionId);
      insertMessage(db, {
        sessionId,
        turnId: turn.id,
        text: index === 0 ? 'a'.repeat(300) : `turn ${index}`,
      });
      store.completeTurn(turn.id);
      store.clearRunning(sessionId, turn.id);
    }

    const first = store.listTurnIndex(sessionId, { limit: 2 });
    const second = store.listTurnIndex(sessionId, {
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.items).toHaveLength(2);
    expect(first.items.every(item => item.anchorMessageId.length > 0)).toBe(true);
    expect(first.nextCursor).toBeTypeOf('string');
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items[0]!.preview).toHaveLength(180);
    expect(second.items[0]!.preview.endsWith('…')).toBe(true);
  });

});

describe('TurnStore — 回滚', () => {
  it('只允许回滚最后一轮，并同步删除该轮消息', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    const { turn: t1 } = startTurn(store, sessionId);
    insertMessage(db, { sessionId, turnId: t1.id, text: 'T1-user' });
    store.completeTurn(t1.id);
    store.clearRunning(sessionId, t1.id);
    const { turn: t2 } = startTurn(store, sessionId);
    insertMessage(db, { sessionId, turnId: t2.id, text: 'T2-user' });
    store.completeTurn(t2.id);
    store.clearRunning(sessionId, t2.id);

    expect(() => store.rewindLastTurn(sessionId, t1.id)).toThrow(/turn_not_latest/);
    store.rewindLastTurn(sessionId, t2.id);

    expect(store.getTurn(t1.id)?.sessionId).toBe(sessionId);
    expect(store.getTurn(t2.id)).toBeUndefined();
    expect(new MessagesRepo(db.sqlite).listForTurn(t2.id)).toHaveLength(0);
  });

  it('回滚运行中、跨 Session 和不存在的 Turn 会被拒绝', () => {
    const { store, db } = makeStore();
    const s1 = insertSession(db, 's1');
    const s2 = insertSession(db, 's2');
    const { turn } = startTurn(store, s1);

    expect(() => store.rewindLastTurn(s1, turn.id)).toThrow(/turn_running/);
    store.abortTurn(s1, turn.id);
    store.clearRunning(s1, turn.id);
    expect(() => store.rewindLastTurn(s2, turn.id)).toThrow(/turn_ownership_violation/);
    expect(() => store.rewindLastTurn(s1, 'turn-ghost')).toThrow(/turn_not_found/);
  });
});
