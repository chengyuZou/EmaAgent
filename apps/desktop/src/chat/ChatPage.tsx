import { useEffect, type JSX } from 'react';
import { mountSystemEvents } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { useServerStore } from '../stores/server.js';
import { useSessionStore } from '../stores/session.js';
import { useSettingsSync } from '../stores/settings-sync.js';
import { useThemeSync } from '../stores/theme.js';
import { NewSessionPage } from './NewSessionPage.js';
import { SessionPage } from './session/SessionPage.js';
import { SessionSidebar } from './sidebar/SessionSidebar.js';
import { useChatWorkspace } from './state/chatWorkspace.js';

export function ChatPage(): JSX.Element {
  const sessionId = useChatWorkspace(state => state.viewedSessionId);
  const serverStatus = useServerStore(state => state.status);
  const hasConnected = useServerStore(state => state.lastKnownPort !== null);
  useThemeSync();
  useSettingsSync(serverStatus.kind === 'ok');

  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => useServerStore.getState().startPolling(), []);
  useEffect(() => {
    void useSessionStore.getState().loadSessions();
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
