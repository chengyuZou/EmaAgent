// 测试 Session、项目、消息读写与独立 Fork 的领域规则。
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { Database, TurnsRepo } from '@ema-agent/storage';
import { DEFAULT_SESSION_TITLE, SessionStore } from '../store.js';

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
    expect(s.permissionMode).toBe('default');
    expect(s.cwd).toBe(path.join(os.homedir(), '.ema-agent', 'workspace'));
  });

  it('creates a session with custom input', () => {
    const { store } = makeStore();
    const s = store.createSession({ title: 'My Chat', cwd: os.tmpdir() });

    expect(s.title).toBe('My Chat');
    expect(s.cwd).toBe(os.tmpdir());
  });

  it('Session 权限模式创建后可修改，Fork 继承当前选择', () => {
    const { store } = makeStore();
    const session = store.createSession({ permissionMode: 'acceptEdits' });
    expect(session.permissionMode).toBe('acceptEdits');

    store.patchSession(session.id, { permissionMode: 'bypassPermissions' });
    expect(store.getSession(session.id).permissionMode).toBe('bypassPermissions');

    const fork = store.forkSession(session.id);
    expect(store.getSession(fork.sessionId).permissionMode).toBe('bypassPermissions');
  });

  it('创建 Project Session 时在同一次操作中写入项目与主工作区', () => {
    const { store } = makeStore();
    const project = store.createProject('Demo', ['D:/main'], 'D:/main');

    const session = store.createSession({
      projectId: project.id,
      executionProfile: 'work',
      narrativePolicy: 'off',
    });

    expect(session).toMatchObject({
      projectId: project.id,
      cwd: 'D:/main',
      executionProfile: 'work',
      narrativePolicy: 'off',
    });
    const chosen = store.createSession({ projectId: project.id, cwd: os.tmpdir() });
    expect(chosen.projectId).toBe(project.id);
    expect(chosen.cwd).toBe(os.tmpdir());
  });

  it('getSession throws for unknown id', () => {
    const { store } = makeStore();
    expect(() => store.getSession('bad-id')).toThrow('session_not_found');
  });

  it('归档的 Session 进入侧栏归档桶，不再出现在最近桶', () => {
    const { store } = makeStore();
    const s = store.createSession();
    store.archiveSession(s.id);

    const grouped = store.listSessionsForSidebar();
    expect(grouped.recent).toHaveLength(0);
    expect(grouped.archived.map((item) => item.id)).toEqual([s.id]);
  });

  it('同时属于项目和置顶的 Session 进置顶桶，项目桶不再列出它', () => {
    const { store } = makeStore();
    const project = store.createProject('Demo', ['D:/main'], 'D:/main');
    const s = store.createSession();
    store.assignSessionToProject(s.id, project.id);
    store.pinSession(s.id);

    const grouped = store.listSessionsForSidebar();
    expect(grouped.pinned.map((item) => item.id)).toEqual([s.id]);
    const projectInSidebar = grouped.projects.find((item) => item.id === project.id)!;
    expect(projectInSidebar.sessions).toHaveLength(0);
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
      modelId: 'model-1',
    });

    store.patchSession(session.id, { model: null });
    expect(store.getSession(session.id)).toMatchObject({
      providerId: null,
      modelId: null,
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
      modelId: 'model-1',
    });
  });
});

describe('SessionStore — 项目', () => {
  it('创建项目时保存多个源文件夹和指定主文件夹', () => {
    const { store } = makeStore();
    expect(() => store.createProject('Demo', [' '], ' ')).toThrow('project_folder_path_empty');

    const project = store.createProject(
      'Demo',
      ['D:/first', 'D:/main'],
      'D:/main',
    );
    expect(project.folders).toContainEqual(expect.objectContaining({
      path: 'D:/first',
      isPrimary: false,
    }));
    expect(project.folders).toContainEqual(expect.objectContaining({
      path: 'D:/main',
      isPrimary: true,
    }));
    expect(project.sessions).toEqual([]);
    expect(store.listProjectFolders(project.id).map((folder) => folder.path)).toEqual([
      'D:/main',
      'D:/first',
    ]);
    expect(store.createSession({ projectId: project.id }).cwd).toBe('D:/main');
  });

  it('拖入项目保留原 cwd，并允许成员显式修改 cwd', () => {
    const { store } = makeStore();
    const session = store.createSession();
    const project = store.createProject('Demo', ['D:/main'], 'D:/main');

    store.assignSessionToProject(session.id, project.id);
    const assigned = store.getSession(session.id);
    expect(assigned.projectId).toBe(project.id);
    expect(assigned.cwd).toBe(session.cwd);

    store.patchSession(session.id, { cwd: 'D:/other' });
    expect(store.getSession(session.id).cwd).toBe('D:/other');

    store.removeSessionFromProject(session.id);
    expect(store.getSession(session.id).projectId).toBeNull();
    expect(store.getSession(session.id).cwd).toBe('D:/other');
  });

  it('拖入项目不会把原 cwd 悄悄加入文件夹清单', () => {
    const { store } = makeStore();
    const session = store.createSession({ cwd: 'D:/loose' });
    const project = store.createProject('Demo', ['D:/main'], 'D:/main');

    store.assignSessionToProject(session.id, project.id);

    const projectInSidebar = store.listSessionsForSidebar().projects.find((item) => item.id === project.id)!;
    expect(projectInSidebar.folders.map((folder) => folder.path)).not.toContain('D:/loose');
    expect(store.getSession(session.id).cwd).toBe('D:/loose');
  });

  it('更换或移除主文件夹不改旧 Session cwd，只改变后续新 Session 的起点', () => {
    const { store } = makeStore();
    const project = store.createProject('Demo', ['D:/main'], 'D:/main');
    const session = store.createSession({ projectId: project.id });
    store.addProjectFolder(project.id, 'D:/second');

    store.setProjectPrimaryFolder(project.id, 'D:/second');

    expect(store.getSession(session.id).cwd).toBe('D:/main');
    expect(store.createSession({ projectId: project.id }).cwd).toBe('D:/second');
    store.removeProjectFolder(project.id, 'D:/main');
    expect(store.getSession(session.id).cwd).toBe('D:/main');
    const projectInSidebar = store.listSessionsForSidebar().projects.find((item) => item.id === project.id)!;
    expect(projectInSidebar.folders[0]!.path).toBe('D:/second');
  });

  it('零文件夹项目可建 Session，之后添加或移除最后一个文件夹也不改旧 cwd', () => {
    const { store } = makeStore();
    const project = store.createProject('Empty', []);
    const session = store.createSession({ projectId: project.id });
    const defaultCwd = path.join(os.homedir(), '.ema-agent', 'workspace');
    expect(session.cwd).toBe(defaultCwd);

    store.addProjectFolder(project.id, 'D:/main');
    expect(store.createSession({ projectId: project.id }).cwd).toBe('D:/main');
    store.removeProjectFolder(project.id, 'D:/main');
    expect(store.getSession(session.id).cwd).toBe(defaultCwd);
    expect(store.listProjectFolders(project.id)).toEqual([]);
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

  it('updateMessageBlocks 整体替换消息的 blocks（流式续写/追加 tool_use）', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    const msg = store.appendMessage({
      sessionId: s.id,
      turnId,
      role: 'assistant',
      blocks: [{ type: 'text', text: '第 1 段' }],
    });
    const next = [
      { type: 'text' as const, text: '第 1 段' },
      { type: 'tool_use' as const, id: 'c1', name: 'Bash', args: { cmd: 'ls' } },
    ];
    store.updateMessageBlocks(msg.id, next);

    const row = db.sqlite.prepare('SELECT blocks_json FROM messages WHERE id = ?')
      .get(msg.id) as { blocks_json: string };
    expect(JSON.parse(row.blocks_json)).toEqual(next);
  });

  it('updateMessageBlocks 对不存在的消息抛错', () => {
    const { store } = makeStore();
    expect(() =>
      store.updateMessageBlocks('no-such-id', [{ type: 'text', text: 'x' }]),
    ).toThrow('message_not_found');
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

  it('appendHistorySummary 按覆盖游标切边界：先于摘要落库但未覆盖的消息不被吞掉', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'covered-a' });
    const through = store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'covered-b' });
    // 摘要生成期间活跃 Turn 写入的消息：先于摘要落库，但不在覆盖范围内。
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', kind: 'reminder', blocks: 'current-reminder' });
    store.appendHistorySummary({
      sessionId: s.id,
      summary: 'summary',
      summarizedThroughMessageId: through.id,
    });
    store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: 'after' });

    // summary 顶替最旧段排第一；未覆盖的 reminder 早于摘要落库也必须存活。
    expect(store.loadHistory(s.id).map((message) => message.blocks))
      .toEqual(['summary', 'current-reminder', 'after']);
  });

  it('appendHistorySummary 拒绝其他 Session 的游标消息', () => {
    const { store, db } = makeStore();
    const a = store.createSession();
    const b = store.createSession();
    const turnId = insertTurnFixture(db, a.id);
    const foreign = store.appendMessage({ sessionId: a.id, turnId, role: 'user', blocks: 'x' });

    expect(() => store.appendHistorySummary({
      sessionId: b.id,
      summary: 's',
      summarizedThroughMessageId: foreign.id,
    })).toThrow(/summary_through_message_not_in_session/);
  });

  it('listMessages 返回旧到新的 Message 页', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    store.appendMessage({ sessionId: s.id, turnId, role: 'user',      blocks: 'old'    });
    store.appendMessage({ sessionId: s.id, turnId, role: 'assistant', blocks: [{ type: 'text', text: 'newest' }] });

    const page = store.listMessages(s.id);
    expect(page.messages.map(message => message.blocks)).toEqual([
      'old',
      [{ type: 'text', text: 'newest' }],
    ]);
    expect(page.olderCursor).toBeUndefined();
  });

  it('listMessages 使用不透明复合游标覆盖同毫秒消息', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);

    for (const value of ['one', 'two', 'three']) {
      store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks: value });
    }

    const newer = store.listMessages(s.id, { limit: 2 });
    const older = store.listMessages(s.id, { before: newer.olderCursor, limit: 2 });

    expect(newer.messages.map(message => message.blocks)).toEqual(['two', 'three']);
    expect(older.messages.map(message => message.blocks)).toEqual(['one']);
    expect(older.olderCursor).toBeUndefined();
  });

  it('listMessagesAround 围绕 Message 返回旧到新的窗口', () => {
    const { store, db } = makeStore();
    const s = store.createSession();
    const turnId = insertTurnFixture(db, s.id);
    const ids = ['one', 'two', 'three', 'four', 'five'].map(blocks => (
      store.appendMessage({ sessionId: s.id, turnId, role: 'user', blocks }).id
    ));

    const window = store.listMessagesAround(s.id, {
      anchorMessageId: ids[2]!,
      before: 1,
      after: 1,
    });

    expect(window.messages.map(message => message.blocks)).toEqual(['two', 'three', 'four']);
    expect(window).toMatchObject({ hasOlder: true, hasNewer: true });
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
    expect(store.listMessages(foreign.id).messages).toHaveLength(0);
  });
});
