import { useEffect, useMemo, useRef, type JSX } from 'react';
import { sessionsApi } from '../api/sessions.js';
import { subscribeSystemEvent } from '../lib/events/systemEventDispatcher.js';
import { ErrorBoundary } from '../lib/errorBoundary.js';
import { useServerStore } from '../stores/server.js';
import { forgetDeletedSessions, useSessionStore } from '../stores/session.js';
import { NewSessionPage } from './NewSessionPage.js';
import { SessionPage } from './session/SessionPage.js';
import { SessionSidebar } from './sidebar/SessionSidebar.js';
import { MainView, useMainNavigationStore } from '../layout/navigation.js';
import { useSessionActivityStore } from '../stores/sessionActivity.js';
import { useSubagentStore } from '../stores/subagent.js';
import { useSessionHistoryStore } from '../stores/sessionHistory.js';
import { removeSessionFromChat } from './session/removeSessionFromChat.js';
import {
  clearSessionSubscriptions,
  syncSessionSubscriptions,
} from './session/sessionSubscriptions.js';

export function ChatPage(): JSX.Element {
  const sessionId = useMainNavigationStore(state => state.viewedSessionId);
  const sessions = useSessionStore(state => state.sessions);
  const loadingSessions = useSessionStore(state => state.loading);
  const sessionListError = useSessionStore(state => state.error);
  const navigationHistory = useMainNavigationStore(state => state.history);
  const activity = useSessionActivityStore(state => state.bySession);
  const progressById = useSubagentStore(state => state.progressById);
  const serverStatus = useServerStore(state => state.status);
  const hasConnected = useServerStore(state => state.lastKnownPort !== null);
  const previousSessions = useRef(sessions.byId);
  useEffect(() => {
    void useSessionStore.getState().loadSessions();
  }, []);
  useEffect(() => {
    const current = useSessionStore.getState();
    if (current.loading || current.error) return;
    // 完整侧栏列表不含归档会话, 刷新后消失的会话也要从聊天导航和本地草稿移除.
    const removed = new Set<string>();
    for (const id of previousSessions.current.keys()) {
      if (!sessions.byId.has(id)) removed.add(id);
    }
    for (const location of navigationHistory) {
      if (location.view === MainView.Chat && location.sessionId && !sessions.byId.has(location.sessionId)) {
        removed.add(location.sessionId);
      }
    }
    for (const id of removed) removeSessionFromChat(id);
    previousSessions.current = sessions.byId;
  }, [sessions.byId, loadingSessions, sessionListError, navigationHistory]);
  const listedSessions = useMemo(() => {
    const byId = new Map<string, { id: string; hasActiveTurn: boolean }>();
    for (const session of [
      ...sessions.pinned,
      ...sessions.pinnedProjects.flatMap(project => project.sessions),
      ...sessions.projects.flatMap(project => project.sessions),
      ...sessions.recent,
    ]) byId.set(session.id, session);
    return [...byId.values()];
  }, [sessions]);
  const subagentSessionIds = useMemo(() => new Set(
    [...progressById.values()].map(progress => progress.sessionId),
  ), [progressById]);
  useEffect(() => {
    const desired = listedSessions
      .filter(session => {
        const current = activity.get(session.id);
        return session.id === sessionId
          || session.hasActiveTurn
          || current?.running != null
          || (current?.pendingInteractions.length ?? 0) > 0
          || (current?.queuedInputs.length ?? 0) > 0
          || subagentSessionIds.has(session.id);
      })
      .map(session => session.id);
    if (sessionId && !desired.includes(sessionId)) desired.push(sessionId);
    syncSessionSubscriptions(new Set(desired));
  }, [activity, subagentSessionIds, listedSessions, sessionId]);
  useEffect(() => () => clearSessionSubscriptions(), []);
  useEffect(() => {
    if (!sessionId) return;
    void sessionsApi.markViewed(sessionId)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});
  }, [sessionId]);
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'sessions_deleted') {
        forgetDeletedSessions(event.sessionIds);
        for (const deletedSessionId of event.sessionIds) {
          removeSessionFromChat(deletedSessionId);
        }
        return;
      }
      if (event.type === 'session_audio_changed') {
        void useSessionHistoryStore.getState().mergeTurnMessages(event.sessionId, event.turnId);
      }
      if (event.type !== 'session_list_changed' && event.type !== 'session_messages_changed') return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void useSessionStore.getState().loadSessions();
      }, 150);
    });
    return () => {
      unsubscribe();
      clearTimeout(refreshTimer);
    };
  }, []);

  if (serverStatus.kind === 'error' && !hasConnected) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--ema-text-tertiary)] ema-fade-in">
        <div className="text-center">
          <div className="mb-2 inline-flex items-center gap-1.5 text-lg">
            <span className="i-lucide:unplug" aria-hidden />
            服务器离线
          </div>
          <div className="text-sm">{serverStatus.reason}</div>
        </div>
      </div>
    );
  }

  if (!hasConnected && (
    serverStatus.kind === 'pending'
      || serverStatus.kind === 'unknown'
  )) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--ema-text-tertiary)] ema-fade-in">
        连接中…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="relative flex h-full flex-row">
        <SessionSidebar />
        {sessionId && sessions.byId.has(sessionId)
          ? <SessionPage sessionId={sessionId} />
          : <NewSessionPage />}
      </div>
    </ErrorBoundary>
  );
}
