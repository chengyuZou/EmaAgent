import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '@ema-agent/storage';
import { SessionStore } from '../src/store.js';
import type { SessionId, TurnId, MessageId } from '@ema-agent/contracts';

function makeStore() {
  const db = new Database({ memory: true, kind: 'data' });
  db.migrate();
  return new SessionStore({ db });
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
});

// ── Turn concurrency ──────────────────────────────────────────────────────────

describe('SessionStore — turn concurrency', () => {
  it('startTurn creates a running turn and returns AbortSignal', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = store.startTurn({
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

    store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'First' });

    expect(() =>
      store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'Second' })
    ).toThrow('session_busy');
  });

  it('sessions are isolated — two sessions can run turns simultaneously', () => {
    const store = makeStore();
    const s1 = store.createSession();
    const s2 = store.createSession();

    expect(() => {
      store.startTurn({ sessionId: s1.id, mode: 'chat', userInput: 'A' });
      store.startTurn({ sessionId: s2.id, mode: 'chat', userInput: 'B' });
    }).not.toThrow();
  });

  it('completeTurn frees the session for a new turn', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'First' });
    store.completeTurn(turn.id, { usageInputTokens: 10, usageOutputTokens: 20 });

    const completed = store.getTurn(turn.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.usageInputTokens).toBe(10);

    // Should be able to start a new turn now
    expect(() =>
      store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'Second' })
    ).not.toThrow();
  });

  it('abortTurn fires AbortSignal and marks turn aborted', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn, signal } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'X' });
    store.abortTurn(s.id, turn.id);

    expect(signal.aborted).toBe(true);
    expect(store.getTurn(turn.id)!.status).toBe('aborted');
  });

  it('failTurn marks turn failed with error code', () => {
    const store = makeStore();
    const s = store.createSession();

    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'X' });
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
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'X' });

    expect(store.getActiveTurn(s.id)!.id).toBe(turn.id);
  });
});

// ── Message ───────────────────────────────────────────────────────────────────

describe('SessionStore — message', () => {
  it('appendMessage stores and returns a message', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'Hi' });

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
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'agent', userInput: 'Run' });

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
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'A' });

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
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'A' });

    for (const text of ['first', 'second', 'third', 'fourth']) {
      store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user', blocks: text });
    }

    expect(store.loadHistory(s.id, 2).map((message) => message.blocks))
      .toEqual(['third', 'fourth']);
  });

  it('loadHistory 保留 summary，并从其后选择最新消息', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'A' });

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
    const { turn: rootTurn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'root' });
    store.appendMessage({ sessionId: s.id, turnId: rootTurn.id, role: 'user', blocks: 'root-message' });
    store.completeTurn(rootTurn.id);

    store.forkMessage({ sessionId: s.id, fromTurnId: rootTurn.id });
    const { turn: branchTurn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'branch' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', kind: 'summary', blocks: 'branch-summary' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-old' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-new-a' });
    store.appendMessage({ sessionId: s.id, turnId: branchTurn.id, role: 'user', blocks: 'branch-new-b' });

    expect(store.loadHistory(s.id, 3).map((message) => message.blocks))
      .toEqual(['branch-summary', 'branch-new-a', 'branch-new-b']);
  });

  it('listMessages (cursor) returns newest-first on first page', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'A' });

    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'user',      blocks: 'old'    });
    store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'newest' }] });

    const page = store.listMessages(s.id);
    expect(page[0]!.blocks).toEqual([{ type: 'text', text: 'newest' }]);
  });

  it('listMessages (cursor) loads older messages with before param', () => {
    const store = makeStore();
    const s = store.createSession();
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'A' });

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
    const { turn } = store.startTurn({ sessionId: s.id, mode: 'chat', userInput: 'X' });

    const msg = store.appendMessage({ sessionId: s.id, turnId: turn.id, role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] });
    store.markMessageInterrupted(msg.id);

    const history = store.loadHistory(s.id);
    expect(history[0]!.interrupted).toBe(true);
  });
});
