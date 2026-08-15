// 测试 Turn 生命周期、单 Session 运行锁、取消信号、删除守卫、导航查询与最后一轮回滚。
import { describe, expect, it } from 'vitest';
import { Database, MessagesRepo, SessionsRepo } from '@ema-agent/storage';
import { TurnStore } from '../turnStore.js';

let seq = 100;

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return { store: new TurnStore({ db }), db };
}

function insertSession(db: Database, id: string): string {
  new SessionsRepo(db.sqlite).insert({
    id: id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

function startTurn(store: TurnStore, sessionId: string) {
  return store.startTurn({
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'chat',
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

  it('终态提交后仍占用运行锁，clearRunning 后才允许新 Turn', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');

    const { turn } = startTurn(store, sessionId);
    store.completeTurn(turn.id, { usageInputTokens: 10, usageOutputTokens: 20 });

    const completed = store.getTurn(turn.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.usageInputTokens).toBe(10);
    expect(() => startTurn(store, sessionId)).toThrow('session_busy');

    store.clearRunning(sessionId, turn.id);
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

    expect(store.getActiveTurn(sessionId)!.id).toBe(second.id);
    expect(() => startTurn(store, sessionId)).toThrow('session_busy');
  });

  it('getActiveTurn 在无运行 Turn 时返回 undefined', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    expect(store.getActiveTurn(sessionId)).toBeUndefined();
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
    expect(first.nextCursor).toBeTypeOf('string');
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items[0]!.preview).toHaveLength(180);
    expect(second.items[0]!.preview.endsWith('…')).toBe(true);
  });

  it('围绕锚点读取前后 Turn 窗口', () => {
    const { store, db } = makeStore();
    const sessionId = insertSession(db, 's1');
    const turns: string[] = [];
    for (let index = 0; index < 5; index++) {
      const { turn } = startTurn(store, sessionId);
      turns.push(turn.id);
      store.completeTurn(turn.id);
      store.clearRunning(sessionId, turn.id);
    }

    const window = store.listTurnWindow(sessionId, {
      anchorTurnId: turns[2]!,
      beforeTurns: 1,
      afterTurns: 1,
    });

    expect(window.turns.map((turn) => turn.id)).toEqual(turns.slice(1, 4));
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(true);
  });

  it('窗口拒绝其他 Session 的锚点 Turn', () => {
    const { store, db } = makeStore();
    const owner = insertSession(db, 'owner');
    const other = insertSession(db, 'other');
    const { turn } = startTurn(store, owner);

    expect(() => store.listTurnWindow(other, {
      anchorTurnId: turn.id,
    })).toThrow('turn_ownership_violation');
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

    expect(store.listTurns(sessionId).map((turn) => turn.id)).toEqual([t1.id]);
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
