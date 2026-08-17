// 测试 Session、项目、消息读写与独立 Fork 的领域规则。
import { describe, it, expect } from 'vitest';
import { Database, TurnsRepo } from '@ema-agent/storage';
import { SessionStore } from '../store.js';

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return { store: new SessionStore({ db }), db };
}

let turnSeq = 0;
/** 消息夹具需要的 Turn 行；Turn 生命周期本身由 TurnStore 的测试覆盖。 */
function insertTurnFixture(db: Database, sessionId: string): string {
  const turnId = `turn-${++turnSeq}`;
  new TurnsRepo(db.sqlite).insert({
    id: turnId,
    sessionId,
    triggerType: 'userMessage',
    executionProfile: 'chat',
    narrativePolicy: 'off',
    createdAt: turnSeq,
  });
  return turnId;
}

// ── Session ───────────────────────────────────────────────────────────────────

describe('SessionStore — session', () => {
  it('creates a session with defaults', () => {
    const { store } = makeStore();
    const s = store.createSession();

    expect(s.id).toBeTypeOf('string');
    expect(s.title).toBe('新对话');
    expect(s.archivedAt).toBeNull();
  });

  it('creates a session with custom input', () => {
    const { store } = makeStore();
    const s = store.createSession({ title: 'My Chat', workspaceRoot: '/tmp' });

    expect(s.title).toBe('My Chat');
    expect(s.workspaceRoot).toBe('/tmp');
  });

  it('getSession throws for unknown id', () => {
    const { store } = makeStore();
    expect(() => store.getSession('bad-id')).toThrow('session_not_found');
  });

  it('归档的 Session 进入侧栏归档桶，不再出现在最近桶', () => {
    const { store } = makeStore();
    const s = store.createSession();
    store.archiveSession(s.id);

    const grouped = store.listSessionsGrouped();
    expect(grouped.recent).toHaveLength(0);
    expect(grouped.archived.map((item) => item.id)).toEqual([s.id]);
  });

  it('同时属于项目和置顶的 Session 进置顶桶，项目桶不再列出它', () => {
    const { store } = makeStore();
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
    const { store } = makeStore();
    const s = store.createSession();
    store.updateTitle(s.id, 'Updated');

    expect(store.getSession(s.id).title).toBe('Updated');
  });

  it('保存和清除该 Session 当前使用的模型', () => {
    const { store } = makeStore();
    const session = store.createSession();

    store.patchSession(session.id, {
      model: {
        providerId: 'provider-config-1',
        modelId: 'model-1',
      },
    });
    expect(store.getSession(session.id)).toMatchObject({
      providerId: 'provider-config-1',
      ModelId: 'model-1',
    });

    store.patchSession(session.id, { model: null });
    expect(store.getSession(session.id)).toMatchObject({
      providerId: null,
      ModelId: null,
    });
  });

  it('Session fork 继承当前模型选择', () => {
    const { store } = makeStore();
    const session = store.createSession();
    store.patchSession(session.id, {
      model: {
        providerId: 'provider-config-1',
        modelId: 'model-1',
      },
    });

    const fork = store.forkSession(session.id);
    expect(store.getSession(fork.sessionId)).toMatchObject({
      providerId: 'provider-config-1',
      ModelId: 'model-1',
    });
  });
});

describe('SessionStore — 项目', () => {
  it('拖入项目锁定工作区为主文件夹，锁定期间 patch 工作区被拒绝', () => {
    const { store } = makeStore();
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
    const { store } = makeStore();
    const session = store.createSession({ workspaceRoot: 'D:/loose' });
    const project = store.createProject('Demo', 'D:/main');

    store.assignSessionToProject(session.id, project.id, true);

    const group = store.listSessionsGrouped().projects.find((g) => g.project.id === project.id)!;
    expect(group.folders.map((folder) => folder.path)).toContain('D:/loose');
    expect(group.folders.find((folder) => folder.path === 'D:/loose')!.isPrimary).toBe(false);
    expect(store.getSession(session.id).workspaceRoot).toBe('D:/main');
  });

  it('更换主文件夹级联改写成员工作区', () => {
    const { store } = makeStore();
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

// ── Message ───────────────────────────────────────────────────────────────────

describe('SessionStore — message', () => {
  it('appendMessage stores and returns a message', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    const msg = store.appendMessage({
      sessionId: s.id,
      turnId,
      role: 'user',
      blocks: 'Hi',
    });

    expect(msg.role).toBe('user');
    expect(msg.blocks).toBe('Hi');
    expect(msg.interrupted).toBe(false);
  });

  it('appendMessage serialises tool_use blocks correctly', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    const blocks = [
      { type: 'text' as const, text: '' },
      { type: 'tool_use' as const, id: 'c1', name: 'Bash', args: { cmd: 'ls' } },
    ];
    const msg = store.appendMessage({
      sessionId: s.id,
      turnId,
      role: 'assistant',
      blocks,
    });

    expect(msg.blocks).toEqual(blocks);
  });

  it('loadHistory returns messages in chronological order', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user',      blocks: 'first'  });
    store.appendMessage({ sessionId: s.id, turnId, role: 'assistant', blocks: [{ type: 'text', text: 'second' }] });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user',      blocks: 'third'  });

    const history = store.loadHistory(s.id);
    expect(history).toHaveLength(3);
    expect(history[0]!.blocks).toBe('first');
    expect(history[2]!.blocks).toBe('third');
  });

  it('loadHistory limit 返回最新消息而不是最早消息', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    for (const text of ['first', 'second', 'third', 'fourth']) {
      store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: text });
    }

    expect(store.loadHistory(s.id, 2).map((message) => message.blocks))
      .toEqual(['third', 'fourth']);
  });

  it('loadHistory 保留 summary，并从其后选择最新消息', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'before' });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', kind: 'summary', blocks: 'summary' });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'post-old' });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'post-new-a' });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'post-new-b' });

    expect(store.loadHistory(s.id, 3).map((message) => message.blocks))
      .toEqual(['summary', 'post-new-a', 'post-new-b']);
  });

  it('listMessagesForTurns 按时间正序返回指定 Turn 集合的消息', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const t1 = insertTurnFixture(db, s.id);
    const t2 = insertTurnFixture(db, s.id);
    store.appendMessage({ sessionId: s.id, turnId: t1, role: 'user', blocks: 'one' });
    store.appendMessage({ sessionId: s.id, turnId: t2, role: 'user', blocks: 'two' });

    expect(store.listMessagesForTurns(s.id, [t1, t2]).map((message) => message.blocks))
      .toEqual(['one', 'two']);
  });

  it('listMessages (cursor) returns newest-first on first page', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user',      blocks: 'old'    });
    store.appendMessage({ sessionId: s.id, turnId, role: 'assistant', blocks: [{ type: 'text', text: 'newest' }] });

    const page = store.listMessages(s.id);
    expect(page[0]!.blocks).toEqual([{ type: 'text', text: 'newest' }]);
  });

  it('listMessages (cursor) loads older messages with before param', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'old' });
    store.appendMessage({ sessionId: s.id, turnId, role: 'assistant', blocks: [{ type: 'text', text: 'new' }] });

    // Ask for messages before 'new' — should only return 'old'
    const newer = store.listMessages(s.id);
    const cursor = newer[0]!.createdAt; // 'new' is at index 0 (newest-first)
    const older = store.listMessages(s.id, { before: cursor });

    expect(older).toHaveLength(1);
    expect(older[0]!.blocks).toBe('old');
  });

  it('markMessageInterrupted sets interrupted flag', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    const msg = store.appendMessage({ sessionId: s.id, turnId, role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] });
    store.markMessageInterrupted(msg.id);

    const history = store.loadHistory(s.id);
    expect(history[0]!.interrupted).toBe(true);
  });

  it('rejects appending a message with a turn from another session', () => {
    const { store, db } = makeStore();
    const owner = store.createSession({ title: 'owner' });
    const foreign = store.createSession({ title: 'foreign' });
    const turnId = insertTurnFixture(db, owner.id);

    expect(() => store.appendMessage({
      sessionId: foreign.id,
      turnId,
      role: 'user',
      blocks: 'must fail',
    })).toThrow('session_ownership_violation');
    expect(store.listMessages(foreign.id)).toHaveLength(0);
  });
});
