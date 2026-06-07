import { useEffect, type JSX } from 'react';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useSidecarStore } from '../stores/sidecar-store.js';
import { startSystemSse } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { SessionSwitcher } from './SessionSwitcher.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';

export function ChatPanel(): JSX.Element {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const isLoading       = useSessionStore((s) => s.loading);
  const sidecarStatus   = useSidecarStore((s) => s.status);

  useEffect(() => { void startSystemSse(); }, []);

  useEffect(() => {
    const stop = useSidecarStore.getState().startPolling();
    return stop;
  }, []);

  useEffect(() => {
    void useSessionStore.getState().loadSessions();
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
      <div className="flex flex-col h-screen bg-gray-950">
        <SessionSwitcher />
        <ChatHistory />
        <ChatInput />

        <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-800 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${sidecarStatus.kind === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
            <span>sidecar</span>
            {sidecarStatus.kind === 'ok' && <span>{sidecarStatus.latencyMs}ms</span>}
          </div>
          {viewedSessionId && (
            <div className="text-gray-600">{(viewedSessionId as string).slice(0, 8)}</div>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}
