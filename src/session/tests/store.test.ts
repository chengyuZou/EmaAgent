// 测试 Session、Turn、消息、分支和崩溃恢复的领域行为。
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { SessionStore } from '../store.js';
import type { SessionId, TurnId, MessageId } from '@ema-agent/contracts';

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return new SessionStore({ db });
}

function startTurn(
  store: SessionStore,
  input: { sessionId: SessionId; mode: 'chat' | 'agent'; userInput: string },
) {
  return store.startTurn({
    sessionId: input.sessionId,
    triggerType: 'userMessage',
    executionProfile: input.mode === 'agent' ? 'work' : 'chat',
    narrativePolicy: 'off',
    userInput: input.userInput,
  });
}

// ── Session ───────────────────────────────────────────────────────────────────

describe('SessionStore — session', () => {
  it('creates a session with defaults', () => {
    const store = makeStore();
    const s = store.createSession();

    expect(s.id).toBeTypeOf('string');
    expect(s.title).toBe('新对话');
    expect(s.archivedAt).toBeNull();
  });

  it('creates a session with custom input', () => {
    const store = makeStore();
    const s = store.createSession({ title: 'My Chat', workspaceRoot: '/tmp' });

    expect(s.title).toBe('My Chat');
    expect(s.workspaceRoot).toBe('/tmp');
  });

  it('getSession throws for unknown id', () => {
    const store = makeStore();
    expect(() => store.getSession('bad-id' as SessionId)).toThrow('session_not_found');
  });

  it('listSessions returns active sessions newest-first', () => {
    const store = makeStore();
    store.createSession({ title: 'A' });
    store.createSession({ title: 'B' });
    const { sessions } = store.listSessions();

    expect(sessions.length).toBe(2);
    expect(sessions[0]!.title).toBe('B'); // newest first
  });

  it('archiveSession hides session from list', () => {
    const store = makeStore();
    const s = store.createSession();
    store.archiveSession(s.id);

    const { sessions } = store.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('updateTitle changes title', () => {
    const store = makeStore();
    const s = store.createSession();
    store.updateTitle(s.id, 'Updated');

    expect(store.getSession(s.id).title).toBe('Updated');
  });

  it('保存和清除该 Session 下一轮想使用的模型', () => {
    const store = makeStore();
    const session = store.createSession();

    store.patchSession(session.id, {
      preferredModel: {
        providerConfigId: 'provider-config-1',
        modelId: 'model-1',
      },
    });
    expect(store.getSession(session.id)).toMatchObject({
      preferredProviderConfigId: 'provider-config-1',
      preferredModelId: 'model-1',
    });

    store.patchSession(session.id, { preferredModel: null });
    expect(store.getSession(session.id)).toMatchObject({
      preferredProviderConfigId: null,
      preferredModelId: null,
    });
  });

  it('已有 Branch 的 Session fork 仍继承下一轮模型偏好', () => {
    const store = makeStore();
    const session = store.createSession();
    store.patchSession(session.id, {
      preferredModel: {
        providerConfigId: 'provider-config-1',
        modelId: 'model-1',
      },
    });
    const { turn } = startTurn(store, {
      sessionId: session.id,
      mode: 'chat',
      userInput: 'root',
    });
    store.completeTurn(turn.id);
    store.forkMessage({ sessionId: session.id, fromTurnId: turn.id });

    const fork = store.forkSession(session.id);
    expect(store.getSession(fork.sessionId)).toMatchObject({
      preferredProviderConfigId: 'provider-config-1',
      preferredModelId: 'model-1',
    });
  });
});

describe('SessionStore — Turn ID 游标遍历', () => {
  it('复合游标覆盖同一 Session 的全部 Turn 且不重复', () => {
    const store = makeStore();
    const session = store.createSession();
    const expected = new Set<string>();
    for (let index = 0; index < 5; index++) {
      const { turn } = startTurn(store, {
        sessionId: session.id,
        mode: 'chat',
        userInput: `turn-${index}`,
      });
      expected.add(turn.id as string);
      store.completeTurn(turn.id);
    }

    const actual: string[] = [];
    let cursor: Parameters<typeof store.listTurnIdsPage>[1];
    do {
      const page = store.listTurnIdsPage(session.id, cursor, 2);
      actual.push(...page.ids);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(new Set(actual)).toEqual(expected);
    expect(actual).toHaveLength(expected.size);
  });
});

// ── Turn concurrency ──────────────────────────────────────────────────────────

describe('SessionStore — turn concurrency', () => {
  it('startTurn creates a running turn and returns AbortSignal', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = startTurn(store, {
      sessionId: s.id,
      mode: 'chat',
      userInput: 'Hello',
    });

    expect(turn.status).toBe('running');
    expect(turn.userInput).toBe('Hello');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('startTurn throws session_busy when a turn is already running', () => {
    const store = makeStore();
    const s = store.createSession();

    startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'First' });

    expect(() =>
      startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'Second' })
    ).toThrow('session_busy');
  });

  it('sessions are isolated — two sessions can run turns simultaneously', () => {
    const store = makeStore();
    const s1 = store.createSession();
    const s2 = store.createSession();

    expect(() => {
      startTurn(store, { sessionId: s1.id, mode: 'chat', userInput: 'A' });
      startTurn(store, { sessionId: s2.id, mode: 'chat', userInput: 'B' });
    }).not.toThrow();
  });

  it('completeTurn frees the session for a new turn', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'First' });
    store.completeTurn(turn.id, { usageInputTokens: 10, usageOutputTokens: 20 });

    const completed = store.getTurn(turn.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.usageInputTokens).toBe(10);

    // Should be able to start a new turn now
    expect(() =>
      startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'Second' })
    ).not.toThrow();
  });

  it('abortTurn fires AbortSignal and marks turn aborted', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'X' });
    store.abortTurn(s.id, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)!.status).toBe('aborted');
  });

  it('requestAbort 只触发信号，不提前写 Turn 终态', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn, signal } = startTurn(store, {
      sessionId: s.id,
      mode: 'agent',
      userInput: 'Stop me safely',
    });

    store.requestAbort(s.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)?.status).toBe('running');
  });

  it('failTurn marks turn failed with error code', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'X' });
    store.failTurn(turn.id, 'provider/timeout', 'LLM timed out');

    const failed = store.getTurn(turn.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('provider/timeout');
    expect(failed.errorMessage).toBe('LLM timed out');
  });

  it('getActiveTurn returns undefined when no turn is running', () => {
    const store = makeStore();
    const s = store.createSession();
    expect(store.getActiveTurn(s.id)).toBeUndefined();
  });

  it('getActiveTurn returns the running turn', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'X' });

    expect(store.getActiveTurn(s.id)!.id).toBe(turn.id);
  });
});

// ── Message ───────────────────────────────────────────────────────────────────

describe('SessionStore — message', () => {
  it('appendMessage stores and returns a message', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'Hi' });

    const msg = store.appendMessage({
      sessionId: s.id,
      turnId: turn.id,
      role: 'user',
      blocks: 'Hi',
    });

    expect(msg.role).toBe('user');
    expect(msg.blocks).toBe('Hi');
    expect(msg.interrupted).toBe(false);
  });

  it('appendMessage serialises tool_use blocks correctly', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'agent', userInput: 'Run' });

    const blocks = [
      { type: 'text' as const, text: '' },
      { type: 'tool_use' as const, id: 'c1', name: 'Bash', args: { cmd: 'ls' } },
    ];
    const msg = store.appendMessage({
      sessionId: s.id,
      turnId: turn.id,
      role: 'assistant',
      blocks,
    });

    expect(msg.blocks).toEqual(blocks);
  });

  it('loadHistory returns messages in chronological order', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user',      blocks: 'first'  });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'second' }] });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user',      blocks: 'third'  });

    const history = store.loadHistory(s.id);
    expect(history).toHaveLength(3);
    expect(history[0]!.blocks).toBe('first');
    expect(history[2]!.blocks).toBe('third');
  });

  it('loadHistory limit 返回最新消息而不是最早消息', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'A' });

    for (const text of ['first', 'second', 'third', 'fourth']) {
      store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: text });
    }

    expect(store.loadHistory(s.id, 2).map((message) => message.blocks))
      .toEqual(['third', 'fourth']);
  });

  it('loadHistory 保留 summary，并从其后选择最新消息', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'before' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', kind: 'summary', blocks: 'summary' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-old' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-new-a' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-new-b' });

    expect(store.loadHistory(s.id, 3).map((message) => message.blocks))
      .toEqual(['summary', 'post-new-a', 'post-new-b']);
  });

  it('分支历史使用与普通历史相同的 summary 和 limit 规则', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: rootTurn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'root' });
    store.appendMessage({ sessionId: s.id, turnId: rootTurn.id, role: 'user', blocks: 'root-message' });
    store.completeTurn(rootTurn.id);

    store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });
    const { turn: branchTurn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'branch' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', kind: 'summary', blocks: 'branch-summary' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-old' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-new-a' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-new-b' });

    expect(store.loadHistory(s.id, 3).map((message) => message.blocks))
      .toEqual(['branch-summary', 'branch-new-a', 'branch-new-b']);
  });

  it('连续 fork 会清掉上一个空 active 分支, 不再堆积空分支(F-052)', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: rootTurn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'root' });
    store.completeTurn(rootTurn.id);

    const first = store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });
    // 不发消息直接再 fork: 上一个空分支(无 turn 无子)应被清掉。
    const second = store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });

    const ids = store.listBranches(s.id).map(b => b.id);
    expect(ids).not.toContain(first.branchId);
    expect(ids).toContain(second.branchId);
  });

  it('有消息的分支再 fork 时不会被误清(F-052)', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: rootTurn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'root' });
    store.completeTurn(rootTurn.id);

    const first = store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });
    // 在第一个分支上产生 turn 后再 fork: 第一个分支有内容, 必须保留。
    const { turn: branchTurn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'on-first-branch' });
    store.completeTurn(branchTurn.id);
    store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });

    const ids = store.listBranches(s.id).map(b => b.id);
    expect(ids).toContain(first.branchId);
  });

  // ── deleteTurnCascade: 删除节点连同子树 ────────────────────────────────────

  /** 构造三层树: root(T1,T2,T3) → B1(U1,U2, fork 自 T2) → B2(V1, fork 自 U1)。 */
  function makeBranchTree(store: ReturnType<typeof makeStore>, sessionId: SessionId) {
    const { turn: t1 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'T1' });
    store.appendMessage({ sessionId, turnId: t1.id, role: 'user', blocks: 'T1-user' });
    store.completeTurn(t1.id);
    const { turn: t2 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'T2' });
    store.appendMessage({ sessionId, turnId: t2.id, role: 'user', blocks: 'T2-user' });
    store.completeTurn(t2.id);
    const { turn: t3 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'T3' });
    store.completeTurn(t3.id);

    const b1 = store.forkMessage({ sessionId, fromTurnId: t2.id });
    const { turn: u1 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'U1' });
    store.appendMessage({ sessionId, turnId: u1.id, role: 'user', blocks: 'U1-user' });
    store.completeTurn(u1.id);
    const { turn: u2 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'U2' });
    store.completeTurn(u2.id);

    const b2 = store.forkMessage({ sessionId, fromTurnId: u1.id });
    const { turn: v1 } = startTurn(store, { sessionId, mode: 'chat', userInput: 'V1' });
    store.appendMessage({ sessionId, turnId: v1.id, role: 'user', blocks: 'V1-user' });
    store.completeTurn(v1.id);

    return { t1, t2, t3, b1, u1, u2, b2, v1 };
  }

  it('删除 T2 级联: T2/T3 + B1(U1,U2) + B2(V1) 全删, root 只剩 T1, active 回退 root', () => {
    const store = makeStore();
    const s = store.createSession();
    const tree = makeBranchTree(store, s.id);
    const rootId = store.listBranches(s.id).find(b => b.parentBranchId === null)!.id;

    const result = store.deleteTurnCascade(s.id, tree.t2.id);

    expect(new Set(result.deletedTurnIds)).toEqual(
      new Set([tree.t2.id, tree.t3.id, tree.u1.id, tree.u2.id, tree.v1.id] as string[]),
    );
    expect(new Set(result.deletedBranchIds)).toEqual(new Set([tree.b1.branchId, tree.b2.branchId] as string[]));

    // root 分支只剩 T1; B1/B2 行已删; active 回退到 root。
    expect(store.listTurns(s.id).map(t => t.id)).toEqual([tree.t1.id]);
    expect(store.listBranches(s.id).map(b => b.id)).toEqual([rootId]);
    expect(store.getSession(s.id).activeBranchId).toBe(rootId);

    // 消息随 turn 显式删除, 不泄漏成无 turn 消息混进 root 视图。
    expect(store.listMessages(s.id).map(m => m.blocks)).toEqual(['T1-user']);
  });

  it('删除 U1(中间分支): U1/U2 + B2(V1) 删, B1 留空但存活, active 回退 B1', () => {
    const store = makeStore();
    const s = store.createSession();
    const tree = makeBranchTree(store, s.id);

    const result = store.deleteTurnCascade(s.id, tree.u1.id);

    expect(new Set(result.deletedTurnIds)).toEqual(new Set([tree.u1.id, tree.u2.id, tree.v1.id] as string[]));
    expect(result.deletedBranchIds).toEqual([tree.b2.branchId]);

    const remaining = store.listTurns(s.id).map(t => t.id);
    expect(new Set(remaining)).toEqual(new Set([tree.t1.id, tree.t2.id, tree.t3.id] as string[]));
    expect(store.listBranches(s.id).map(b => b.id)).toContain(tree.b1.branchId);
    expect(store.getSession(s.id).activeBranchId).toBe(tree.b1.branchId);
  });

  it('运行中的 turn 拒绝删除(turn_running)', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: running } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'running' });
    // root 无分支时先 fork 出分支再删? 不需要——root 首次 fork 后 turn 在 root 分支上。
    const first = store.forkMessage({ sessionId: s.id, fromTurnId: running.id });

    expect(() => store.deleteTurnCascade(s.id, running.id)).toThrow(/turn_running/);
    store.abortTurn(s.id, running.id);
    expect(first.branchId).toBeTypeOf('string');
  });

  it('从未 fork 的会话: 删除隐式主干上的 turn 及其后继', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: t1 } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'T1' });
    store.appendMessage({ sessionId: s.id, turnId: t1.id, role: 'user', blocks: 'T1-user' });
    store.completeTurn(t1.id);
    const { turn: t2 } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'T2' });
    store.appendMessage({ sessionId: s.id, turnId: t2.id, role: 'user', blocks: 'T2-user' });
    store.completeTurn(t2.id);
    const { turn: t3 } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'T3' });
    store.completeTurn(t3.id);

    const result = store.deleteTurnCascade(s.id, t2.id);

    expect(new Set(result.deletedTurnIds)).toEqual(new Set([t2.id, t3.id] as string[]));
    expect(result.deletedBranchIds).toEqual([]);
    expect(store.listTurns(s.id).map(t => t.id)).toEqual([t1.id]);
    expect(store.listMessages(s.id).map(m => m.blocks)).toEqual(['T1-user']);
  });

  it('跨 session 删除拒绝(ownership) + 不存在 turn 报 turn_not_found', () => {
    const store = makeStore();
    const s1 = store.createSession();
    const s2 = store.createSession();
    const tree = makeBranchTree(store, s1.id);

    expect(() => store.deleteTurnCascade(s2.id, tree.t2.id)).toThrow(/ownership/);
    expect(() => store.deleteTurnCascade(s1.id, 'turn-ghost' as TurnId)).toThrow(/turn_not_found/);
  });

  it('listMessages (cursor) returns newest-first on first page', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user',      blocks: 'old'    });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'newest' }] });

    const page = store.listMessages(s.id);
    expect(page[0]!.blocks).toEqual([{ type: 'text', text: 'newest' }]);
  });

  it('listMessages (cursor) loads older messages with before param', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'old' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'new' }] });

    // Ask for messages before 'new' — should only return 'old'
    const newer = store.listMessages(s.id);
    const cursor = newer[0]!.createdAt; // 'new' is at index 0 (newest-first)
    const older = store.listMessages(s.id, { before: cursor });

    expect(older).toHaveLength(1);
    expect(older[0]!.blocks).toBe('old');
  });

  it('markMessageInterrupted sets interrupted flag', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, mode: 'chat', userInput: 'X' });

    const msg = store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] });
    store.markMessageInterrupted(msg.id);

    const history = store.loadHistory(s.id);
    expect(history[0]!.interrupted).toBe(true);
  });

  it('rejects appending a message with a turn from another session', () => {
    const store = makeStore();
    const owner = store.createSession({ title: 'owner' });
    const foreign = store.createSession({ title: 'foreign' });
    const { turn } = startTurn(store, {
      sessionId: owner.id,
      mode: 'chat',
      userInput: 'owner turn',
    });

    expect(() => store.appendMessage({
      sessionId: foreign.id,
      turnId: turn.id,
      role: 'user',
      blocks: 'must fail',
    })).toThrow('session_ownership_violation');
    expect(store.listMessages(foreign.id)).toHaveLength(0);
  });
});
