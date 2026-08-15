// 测试 Session、Turn、消息、独立 Fork、最后一轮回滚和崩溃恢复。
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { SessionStore } from '../store.js';
import type { SessionId, TurnId, MessageId } from '@ema-agent/ids';

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return new SessionStore({ db });
}

function startTurn(
  store: SessionStore,
  input: { sessionId: SessionId; executionProfile: 'chat' | 'work'; userInput?: string },
) {
  return store.startTurn({
    sessionId: input.sessionId,
    triggerType: 'userMessage',
    executionProfile: input.executionProfile,
    narrativePolicy: 'off',
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

  it('归档的 Session 进入侧栏归档桶，不再出现在最近桶', () => {
    const store = makeStore();
    const s = store.createSession();
    store.archiveSession(s.id);

    const grouped = store.listSessionsGrouped();
    expect(grouped.recent).toHaveLength(0);
    expect(grouped.archived.map((item) => item.id)).toEqual([s.id]);
  });

  it('同时属于项目和置顶的 Session 进置顶桶，项目桶不再列出它', () => {
    const store = makeStore();
    const project = store.createProject('Demo', 'D:/main');
    const s = store.createSession();
    store.assignSessionToProject(s.id, project.id);
    store.pinSession(s.id);

    const grouped = store.listSessionsGrouped();
    expect(grouped.pinned.map((item) => item.id)).toEqual([s.id]);
    const group = grouped.projects.find((g) => g.project.id === project.id)!;
    expect(group.sessions).toHaveLength(0);
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
      model: {
        providerConfigId: 'provider-config-1',
        modelId: 'model-1',
      },
    });
    expect(store.getSession(session.id)).toMatchObject({
      ProviderConfigId: 'provider-config-1',
      ModelId: 'model-1',
    });

    store.patchSession(session.id, { model: null });
    expect(store.getSession(session.id)).toMatchObject({
      ProviderConfigId: null,
      ModelId: null,
    });
  });

  it('Session fork 继承下一轮模型偏好', () => {
    const store = makeStore();
    const session = store.createSession();
    store.patchSession(session.id, {
      model: {
        providerConfigId: 'provider-config-1',
        modelId: 'model-1',
      },
    });
    const { turn } = startTurn(store, {
      sessionId: session.id,
      executionProfile: 'chat',
      userInput: 'root',
    });
    store.completeTurn(turn.id);
    store.clearRunning(session.id, turn.id);

    const fork = store.forkSession(session.id);
    expect(store.getSession(fork.sessionId)).toMatchObject({
      ProviderConfigId: 'provider-config-1',
      ModelId: 'model-1',
    });
  });
});

describe('SessionStore — 项目', () => {
  it('拖入项目锁定工作区为主文件夹，锁定期间 patch 工作区被拒绝', () => {
    const store = makeStore();
    const session = store.createSession();
    const project = store.createProject('Demo', 'D:/main');

    store.assignSessionToProject(session.id, project.id);
    const assigned = store.getSession(session.id);
    expect(assigned.projectId).toBe(project.id);
    expect(assigned.workspaceRoot).toBe('D:/main');

    expect(() => store.patchSession(session.id, { workspaceRoot: 'D:/other' }))
      .toThrow('session_workspace_locked_by_project');

    store.removeSessionFromProject(session.id);
    expect(store.getSession(session.id).projectId).toBeNull();
    expect(() => store.patchSession(session.id, { workspaceRoot: 'D:/other' })).not.toThrow();
  });

  it('拖入时确认保留原工作区会把它加为非主文件夹', () => {
    const store = makeStore();
    const session = store.createSession({ workspaceRoot: 'D:/loose' });
    const project = store.createProject('Demo', 'D:/main');

    store.assignSessionToProject(session.id, project.id, true);

    const group = store.listSessionsGrouped().projects.find((g) => g.project.id === project.id)!;
    expect(group.folders.map((folder) => folder.path)).toContain('D:/loose');
    expect(group.folders.find((folder) => folder.path === 'D:/loose')!.isPrimary).toBe(false);
    expect(store.getSession(session.id).workspaceRoot).toBe('D:/main');
  });

  it('更换主文件夹级联改写成员工作区', () => {
    const store = makeStore();
    const session = store.createSession();
    const project = store.createProject('Demo', 'D:/main');
    store.addProjectFolder(project.id, 'D:/second');
    store.assignSessionToProject(session.id, project.id);

    store.setProjectPrimaryFolder(project.id, 'D:/second');

    expect(store.getSession(session.id).workspaceRoot).toBe('D:/second');
    const group = store.listSessionsGrouped().projects.find((g) => g.project.id === project.id)!;
    expect(group.folders[0]!.path).toBe('D:/second');
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
        executionProfile: 'chat',
        userInput: `turn-${index}`,
      });
      expected.add(turn.id as string);
      store.completeTurn(turn.id);
      store.clearRunning(session.id, turn.id);
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

describe('SessionStore — 聊天历史导航', () => {
  it('Turn 索引使用不透明游标分页，预览取自首条 User Message', () => {
    const store = makeStore();
    const session = store.createSession();
    for (let index = 0; index < 3; index++) {
      const { turn } = startTurn(store, {
        sessionId: session.id,
        executionProfile: 'chat',
      });
      store.appendMessage({
        sessionId: session.id,
        turnId: turn.id,
        role: 'user',
        blocks: index === 0 ? 'a'.repeat(300) : `turn ${index}`,
      });
      store.completeTurn(turn.id);
      store.clearRunning(session.id, turn.id);
    }

    const first = store.listTurnIndex(session.id, { limit: 2 });
    const second = store.listTurnIndex(session.id, {
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

  it('围绕锚点读取前后 Turn，并按时间正序返回消息', () => {
    const store = makeStore();
    const session = store.createSession();
    const turns: TurnId[] = [];
    for (let index = 0; index < 5; index++) {
      const { turn } = startTurn(store, {
        sessionId: session.id,
        executionProfile: 'chat',
        userInput: `turn ${index}`,
      });
      turns.push(turn.id);
      store.appendMessage({
        sessionId: session.id,
        turnId: turn.id,
        role: 'user',
        blocks: `message ${index}`,
      });
      store.completeTurn(turn.id);
      store.clearRunning(session.id, turn.id);
    }

    const window = store.listMessageWindow(session.id, {
      anchorTurnId: turns[2]!,
      beforeTurns: 1,
      afterTurns: 1,
    });

    expect(window.turns.map((turn) => turn.id)).toEqual(turns.slice(1, 4));
    expect(window.messages.map((message) => message.blocks)).toEqual([
      'message 1',
      'message 2',
      'message 3',
    ]);
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(true);
  });

  it('消息窗口拒绝其他 Session 的锚点 Turn', () => {
    const store = makeStore();
    const owner = store.createSession();
    const other = store.createSession();
    const { turn } = startTurn(store, {
      sessionId: owner.id,
      executionProfile: 'chat',
      userInput: 'owner',
    });

    expect(() => store.listMessageWindow(other.id, {
      anchorTurnId: turn.id,
    })).toThrow('session_ownership_violation');
  });
});

// ── Turn concurrency ──────────────────────────────────────────────────────────

describe('SessionStore — turn concurrency', () => {
  it('Session 进入删除准备后拒绝创建新 Turn', () => {
    const store = makeStore();
    const session = store.createSession();

    store.beginSessionDeletion(session.id);

    expect(() => startTurn(store, {
      sessionId: session.id,
      executionProfile: 'chat',
      userInput: 'too late',
    })).toThrow('session_deleting');

    store.cancelSessionDeletion(session.id);
    expect(() => startTurn(store, {
      sessionId: session.id,
      executionProfile: 'chat',
      userInput: 'retry',
    })).not.toThrow();
  });

  it('startTurn creates a running turn and returns AbortSignal', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = startTurn(store, {
      sessionId: s.id,
      executionProfile: 'chat',
      userInput: 'Hello',
    });

    expect(turn.status).toBe('running');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('startTurn throws session_busy when a turn is already running', () => {
    const store = makeStore();
    const s = store.createSession();

    startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'First' });

    expect(() =>
      startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'Second' })
    ).toThrow('session_busy');
  });

  it('sessions are isolated — two sessions can run turns simultaneously', () => {
    const store = makeStore();
    const s1 = store.createSession();
    const s2 = store.createSession();

    expect(() => {
      startTurn(store, { sessionId: s1.id, executionProfile: 'chat', userInput: 'A' });
      startTurn(store, { sessionId: s2.id, executionProfile: 'chat', userInput: 'B' });
    }).not.toThrow();
  });

  it('终态提交后仍由执行器最终释放 Session', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'First' });
    store.completeTurn(turn.id, { usageInputTokens: 10, usageOutputTokens: 20 });

    const completed = store.getTurn(turn.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.usageInputTokens).toBe(10);

    expect(() =>
      startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'Too early' })
    ).toThrow('session_busy');

    store.clearRunning(s.id, turn.id);

    expect(() =>
      startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'Second' })
    ).not.toThrow();
  });

  it('abortTurn fires AbortSignal and marks turn aborted', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'X' });
    store.abortTurn(s.id, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)!.status).toBe('aborted');
  });

  it('requestAbort 只触发信号，不提前写 Turn 终态', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn, signal } = startTurn(store, {
      sessionId: s.id,
      executionProfile: 'work',
      userInput: 'Stop me safely',
    });

    store.requestAbort(s.id, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)?.status).toBe('running');
  });

  it('failTurn marks turn failed with error code', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'X' });
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
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'X' });

    expect(store.getActiveTurn(s.id)!.id).toBe(turn.id);
  });
});

// ── Message ───────────────────────────────────────────────────────────────────

describe('SessionStore — message', () => {
  it('appendMessage stores and returns a message', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'Hi' });

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
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'work', userInput: 'Run' });

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
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'A' });

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
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'A' });

    for (const text of ['first', 'second', 'third', 'fourth']) {
      store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: text });
    }

    expect(store.loadHistory(s.id, 2).map((message) => message.blocks))
      .toEqual(['third', 'fourth']);
  });

  it('loadHistory 保留 summary，并从其后选择最新消息', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'before' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', kind: 'summary', blocks: 'summary' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-old' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-new-a' });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: 'post-new-b' });

    expect(store.loadHistory(s.id, 3).map((message) => message.blocks))
      .toEqual(['summary', 'post-new-a', 'post-new-b']);
  });

  it('只允许回滚最后一轮，并同步删除该轮消息', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn: t1 } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'T1' });
    store.appendMessage({ sessionId: s.id, turnId: t1.id, role: 'user', blocks: 'T1-user' });
    store.completeTurn(t1.id);
    store.clearRunning(s.id, t1.id);
    const { turn: t2 } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'T2' });
    store.appendMessage({ sessionId: s.id, turnId: t2.id, role: 'user', blocks: 'T2-user' });
    store.completeTurn(t2.id);
    store.clearRunning(s.id, t2.id);
    expect(() => store.rewindLastTurn(s.id, t1.id)).toThrow(/turn_not_latest/);
    store.rewindLastTurn(s.id, t2.id);

    expect(store.listTurns(s.id).map(t => t.id)).toEqual([t1.id]);
    expect(store.listMessages(s.id).map(m => m.blocks)).toEqual(['T1-user']);
  });

  it('回滚运行中、跨 Session 和不存在的 Turn 会被拒绝', () => {
    const store = makeStore();
    const s1 = store.createSession();
    const s2 = store.createSession();
    const { turn } = startTurn(store, { sessionId: s1.id, executionProfile: 'chat', userInput: 'running' });

    expect(() => store.rewindLastTurn(s1.id, turn.id)).toThrow(/turn_running/);
    store.abortTurn(s1.id, turn.id);
    store.clearRunning(s1.id, turn.id);
    expect(() => store.rewindLastTurn(s2.id, turn.id)).toThrow(/ownership/);
    expect(() => store.rewindLastTurn(s1.id, 'turn-ghost' as TurnId)).toThrow(/turn_not_found/);
  });

  it('旧 Turn 的迟到释放不会清除新 Turn', () => {
    const store = makeStore();
    const session = store.createSession();
    const { turn: first } = startTurn(store, {
      sessionId: session.id,
      executionProfile: 'work',
      userInput: 'first',
    });
    store.completeTurn(first.id);
    store.clearRunning(session.id, first.id);

    const { turn: second } = startTurn(store, {
      sessionId: session.id,
      executionProfile: 'work',
      userInput: 'second',
    });

    store.clearRunning(session.id, first.id);

    expect(store.getActiveTurn(session.id)?.id).toBe(second.id);
    expect(() =>
      startTurn(store, { sessionId: session.id, executionProfile: 'work', userInput: 'third' })
    ).toThrow('session_busy');
  });

  it('listMessages (cursor) returns newest-first on first page', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user',      blocks: 'old'    });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'newest' }] });

    const page = store.listMessages(s.id);
    expect(page[0]!.blocks).toEqual([{ type: 'text', text: 'newest' }]);
  });

  it('listMessages (cursor) loads older messages with before param', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'A' });

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
    const { turn } = startTurn(store, { sessionId: s.id, executionProfile: 'chat', userInput: 'X' });

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
      executionProfile: 'chat',
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
