import { useEffect, type JSX } from 'react';
import type { SessionId } from '@ema-agent/contracts';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useSidecarStore } from '../stores/sidecar-store.js';
import { startSystemSse } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { SessionSidebar } from './SessionSidebar.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { ContextPanel } from './ContextPanel.js';

export function ChatPanel(): JSX.Element {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const sidecarStatus   = useSidecarStore((s) => s.status);

  useEffect(() => { void startSystemSse(); }, []);

  useEffect(() => {
    const stop = useSidecarStore.getState().startPolling();
    return stop;
  }, []);

  useEffect(() => {
    void (async () => {
      await useSessionStore.getState().loadSessions();
      // Auto-select the most recently viewed / most recent session on startup.
      if (!useConversationStore.getState().viewedSessionId) {
        const { sessions } = useSessionStore.getState();
        // Prefer session with latest last_viewed_at, fall back to first in recent list.
        const allSessions = [...sessions.pinned, ...sessions.recent];
        const best = allSessions.reduce<{ id: string; ts: number } | null>((prev, s) => {
          const ts = s.lastViewedAt ?? 0;
          return !prev || ts > prev.ts ? { id: s.id, ts } : prev;
        }, null);
        const pick = best?.id ?? sessions.recent[0]?.id ?? sessions.pinned[0]?.id;
        if (pick) void useConversationStore.getState().viewSession(pick as SessionId);
      }
    })();
  }, []);

  if (sidecarStatus.kind === 'error') {
    return (
      <div className="flex items-center justify-center h-screen text-gray-400">
        <div className="text-center">
          <div className="text-lg mb-2">⚡ Sidecar 离线</div>
          <div className="text-sm text-gray-500">{sidecarStatus.reason}</div>
        </div>
      </div>
    );
  }

  if (sidecarStatus.kind === 'pending' || sidecarStatus.kind === 'unknown') {
    return (
      <div className="flex items-center justify-center h-screen text-gray-500">
        连接中…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-row h-screen bg-neutral-950">
        <SessionSidebar />

        {/* Main chat area */}
        <div className="flex flex-col flex-1 min-w-0">
          <ChatHistory />
          <ChatInput />

          <div className="flex items-center justify-between px-4 py-1.5 border-t border-neutral-800 text-xs text-neutral-500">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${sidecarStatus.kind === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
              <span>sidecar</span>
              {sidecarStatus.kind === 'ok' && <span>{sidecarStatus.latencyMs}ms</span>}
            </div>
            <div className="flex items-center gap-3">
              <ContextPanel />
              {viewedSessionId && (
                <span className="text-neutral-700">{(viewedSessionId as string).slice(0, 8)}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
