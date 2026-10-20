// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../src/api/sessions.js';
import type { PermissionResponse } from '@ema-agent/permission';
import type { InteractionNotificationAction, InteractionNotificationUpdate } from '../src/lib/tauri/types.js';
import { mountInteractionNotifications } from '../src/lib/notifications/interactionNotifications.js';
import { MainView, useMainNavigationStore } from '../src/layout/navigation.js';
import { useSessionActivityStore } from '../src/stores/sessionActivity.js';
import { useSessionStore } from '../src/stores/session.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  sync: vi.fn(async (_update: InteractionNotificationUpdate) => {}),
  open: vi.fn(async () => {}),
  respond: vi.fn(async (_sessionId: string, _toolCallId: string, _response: PermissionResponse) => {}),
  toast: vi.fn(),
}));

vi.mock('../src/lib/tauri/tauriBridge.js', () => ({
  tauriBridge: {
    connectInteractionNotifications: mocks.connect,
    syncInteractionNotifications: mocks.sync,
    openMainWindow: mocks.open,
  },
}));
vi.mock('../src/api/sessionWebSocket.js', () => ({
  sessionWebSocket: { respondPermission: mocks.respond },
  SessionRequestError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: mocks.toast }));
vi.mock('../src/api/sessions.js', () => ({ sessionsApi: {} }));
vi.mock('../src/api/workspaces.js', () => ({ sidebarApi: {} }));

let action: (event: InteractionNotificationAction) => void;
let stop: (() => void) | undefined;

function permission(sessionId: string, toolCallId: string): void {
  const store = useSessionActivityStore.getState();
  store.setConnection(sessionId, 'connected');
  store.applyInteractionEvent(sessionId, {
    type: 'permission_required',
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId,
    toolName: 'Read',
    toolDescription: 'Read a file',
    input: { secret: 'not part of a desktop notification' },
  });
}

function ask(sessionId: string, toolCallId: string): void {
  useSessionActivityStore.getState().applyInteractionEvent(sessionId, {
    type: 'ask_user_required',
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId,
    questions: [],
  });
}

function resolved(sessionId: string, toolCallId: string): void {
  useSessionActivityStore.getState().applyInteractionEvent(sessionId, {
    type: 'permission_resolved',
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId,
    decision: 'allow',
  });
}

async function mount(): Promise<void> {
  stop = mountInteractionNotifications();
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sync.mockImplementation(async () => {});
  mocks.respond.mockImplementation(async () => {});
  mocks.connect.mockImplementation(async handler => {
    action = handler;
    return true;
  });
  useSessionActivityStore.setState({ bySession: new Map() });
  useSessionStore.setState({
    sessions: {
      pinned: [],
      pinnedProjects: [],
      projects: [],
      recent: [],
      byId: new Map([
        ['a', { id: 'a', title: 'Session A' } as SessionListItem],
        ['b', { id: 'b', title: 'Session B' } as SessionListItem],
      ]),
    },
  });
  useMainNavigationStore.setState({
    activeView: MainView.Chat,
    viewedSessionId: 'a',
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('native interaction notifications', () => {
  it('sends one mixed-queue head per Session and the currently viewed Chat target', async () => {
    permission('a', 'first');
    ask('a', 'second');
    permission('a', 'third');
    ask('b', 'other-session');
    await mount();

    expect(mocks.sync).toHaveBeenLastCalledWith({
      viewedSessionId: 'a',
      notifications: [
        {
          sessionId: 'a',
          turnId: 'turn-a',
          toolCallId: 'first',
          kind: 'permission',
          title: 'Session A',
          body: '工具 Read 正在等待你的授权\nRead a file',
        },
        {
          sessionId: 'b',
          turnId: 'turn-b',
          toolCallId: 'other-session',
          kind: 'askUser',
          title: 'Session B',
          body: '你的助手有个问题想问你',
        },
      ],
    });
    useMainNavigationStore.getState().setActiveView(MainView.Settings);
    await vi.waitFor(() => {
      expect(mocks.sync.mock.lastCall?.[0]).toMatchObject({ viewedSessionId: null });
    });
    useMainNavigationStore.getState().viewSession('b');
    await vi.waitFor(() => {
      expect(mocks.sync.mock.lastCall?.[0]).toMatchObject({ viewedSessionId: 'b' });
    });
  });

  it.each(['allow', 'allowSession', 'deny'] as const)(
    'submits %s through the existing Permission entry without removing pending state',
    async approval => {
      permission('a', 'first');
      await mount();
      action({ sessionId: 'a', turnId: 'turn-a', toolCallId: 'first', action: approval });
      await vi.waitFor(() => {
        expect(mocks.respond).toHaveBeenCalledOnce();
        expect(mocks.respond).toHaveBeenCalledWith('a', 'first', { action: approval });
      });
      expect(useSessionActivityStore.getState().bySession.get('a')?.pendingInteractions).toHaveLength(1);
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it('opens the originating Ask Session without submitting an answer', async () => {
    ask('b', 'question');
    await mount();
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'question', action: 'openSession' });
    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    expect(useMainNavigationStore.getState().viewedSessionId).toBe('b');
    expect(useSessionActivityStore.getState().bySession.get('b')?.pendingInteractions).toHaveLength(1);
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it('ignores a queued Permission behind Ask and duplicate clicks during submission', async () => {
    ask('a', 'question');
    permission('a', 'later');
    permission('b', 'first');
    let finish!: () => void;
    mocks.respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await mount();
    action({ sessionId: 'a', turnId: 'turn-a', toolCallId: 'later', action: 'allow' });
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'first', action: 'allow' });
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'first', action: 'deny' });
    expect(mocks.respond).toHaveBeenCalledOnce();
    expect(mocks.respond).toHaveBeenCalledWith('b', 'first', { action: 'allow' });
    finish();
    resolved('b', 'first');
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'first', action: 'allow' });
    await vi.waitFor(() => {
      expect(mocks.sync.mock.lastCall?.[0]).toMatchObject({
        notifications: [{ toolCallId: 'question', kind: 'askUser' }],
      });
    });
    expect(mocks.respond).toHaveBeenCalledOnce();
  });

  it('serializes IPC and rereads current state after a slow notification update', async () => {
    permission('a', 'first');
    let release!: () => void;
    mocks.sync.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await mount();
    resolved('a', 'first');
    permission('b', 'new');
    useMainNavigationStore.getState().setActiveView(MainView.Settings);
    expect(mocks.sync).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    expect(mocks.sync.mock.lastCall?.[0]).toMatchObject({
      viewedSessionId: null,
      notifications: [{ sessionId: 'b', toolCallId: 'new' }],
    });
  });

  it('separates reused provider call IDs and rejects clicks from an earlier Turn', async () => {
    permission('a', 'shared-call');
    permission('b', 'shared-call');
    let finish!: () => void;
    mocks.respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await mount();
    expect(mocks.sync.mock.lastCall?.[0].notifications).toHaveLength(2);

    action({ sessionId: 'a', turnId: 'previous-turn', toolCallId: 'shared-call', action: 'allow' });
    expect(mocks.respond).not.toHaveBeenCalled();
    action({ sessionId: 'a', turnId: 'turn-a', toolCallId: 'shared-call', action: 'allow' });
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'shared-call', action: 'deny' });
    expect(mocks.respond).toHaveBeenCalledTimes(2);
    expect(mocks.respond).toHaveBeenNthCalledWith(1, 'a', 'shared-call', { action: 'allow' });
    expect(mocks.respond).toHaveBeenNthCalledWith(2, 'b', 'shared-call', { action: 'deny' });
    finish();
  });

  it('keeps request identities across reconnects and promotes the next queue head', async () => {
    permission('a', 'first');
    ask('a', 'next');
    await mount();
    const pending = useSessionActivityStore.getState().bySession.get('a')!.pendingInteractions;
    useSessionActivityStore.getState().replaceSessionState('a', null, pending, []);
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
    expect(mocks.sync.mock.calls[0]?.[0]).toEqual(mocks.sync.mock.calls[1]?.[0]);
    resolved('a', 'first');
    await vi.waitFor(() => {
      expect(mocks.sync.mock.lastCall?.[0]).toMatchObject({
        notifications: [{ toolCallId: 'next', kind: 'askUser' }],
      });
    });
  });

  it('returns an offline approval to Chat instead of queueing a hidden answer', async () => {
    permission('b', 'first');
    useSessionActivityStore.getState().setConnection('b', 'reconnecting');
    await mount();
    action({ sessionId: 'b', turnId: 'turn-b', toolCallId: 'first', action: 'allow' });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(useMainNavigationStore.getState().viewedSessionId).toBe('b');
    expect(mocks.respond).not.toHaveBeenCalled();
  });

  it('does not subscribe or publish after unmount while native setup is still pending', async () => {
    let ready!: (supported: boolean) => void;
    mocks.connect.mockImplementationOnce(() => new Promise<boolean>(resolve => { ready = resolve; }));
    const dispose = mountInteractionNotifications();
    dispose();
    ready(true);
    await Promise.resolve();
    permission('a', 'first');
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
