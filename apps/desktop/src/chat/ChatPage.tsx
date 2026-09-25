import { useEffect, useMemo, type JSX } from 'react';
import { mountSystemEvents } from '../lib/system-sse.js';
import { sessionsApi } from '../api/sessions.js';
import { subscribeSystemEvent } from '../lib/system-event-dispatcher.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { useServerStore } from '../stores/server.js';
import { useSessionStore } from '../stores/session.js';
import { useSettingsSync } from '../stores/settings-sync.js';
import { useThemeSync } from '../stores/theme.js';
import { NewSessionPage } from './NewSessionPage.js';
import { SessionPage } from './session/SessionPage.js';
import { SessionSidebar } from './sidebar/SessionSidebar.js';
import { useChatNavigationStore } from '../stores/chatNavigation.js';
import { useSessionActivityStore } from '../stores/sessionActivity.js';
import { useSubagentStore } from '../stores/subagent.js';
import { handleBackgroundProcessSystemEvent } from '../stores/backgroundProcess.js';
import { handleKnowledgeSystemEvent, useKnowledgeStore } from '../stores/knowledge.js';
import { handleMcpSystemEvent } from '../stores/mcp.js';
import { handleSettingsSystemEvent } from '../stores/settings.js';
import { handleSkillSystemEvent } from '../stores/skill.js';
import { handleTaskSystemEvent } from '../stores/task.js';
import { useSessionHistoryStore } from '../stores/sessionHistory.js';
import { useChatDraftStore } from '../stores/chatDraft.js';
import {
  clearSessionSubscriptions,
  syncSessionSubscriptions,
} from './session/sessionSubscriptions.js';

export function ChatPage(): JSX.Element {
  const sessionId = useChatNavigationStore(state => state.viewedSessionId);
  const sessions = useSessionStore(state => state.sessions);
  const activity = useSessionActivityStore(state => state.bySession);
  const progressById = useSubagentStore(state => state.progressById);
  const serverStatus = useServerStore(state => state.status);
  const hasConnected = useServerStore(state => state.lastKnownPort !== null);
  useThemeSync();
  useSettingsSync(serverStatus.kind === 'ok');

  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => useServerStore.getState().startPolling(), []);
  useEffect(() => {
    void useSessionStore.getState().loadSessions();
    void useKnowledgeStore.getState().loadLibs();
  }, []);
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
      handleBackgroundProcessSystemEvent(event);
      handleKnowledgeSystemEvent(event);
      if (event.type === 'kb_active_changed') {
        useChatDraftStore.getState().clearSelectedAssetIds();
      } else if (event.type === 'kb_document_deleted') {
        useChatDraftStore.getState().removeSelectedAssetId(event.assetId);
      }
      handleMcpSystemEvent(event);
      handleSettingsSystemEvent(event);
      handleSkillSystemEvent(event);
      handleTaskSystemEvent(event);
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
      <div className="flex h-screen items-center justify-center text-[var(--ema-text-tertiary)] ema-fade-in">
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
      <div className="flex h-screen items-center justify-center text-[var(--ema-text-tertiary)] ema-fade-in">
        连接中…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex h-screen flex-row bg-[var(--ema-bg)]">
        <SessionSidebar />
        {sessionId
          ? <SessionPage sessionId={sessionId} />
          : <NewSessionPage />}
      </div>
    </ErrorBoundary>
  );
}
