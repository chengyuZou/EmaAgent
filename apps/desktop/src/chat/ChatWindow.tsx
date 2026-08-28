// 组装会话侧栏、消息历史、输入区与窗口 Dock，并维护聊天窗口生命周期。
import { useEffect, type JSX } from 'react';

import { useCurrentSession } from './state/currentSession.js';
import { useSessionStore } from '../stores/session.js';
import { useServerStore } from '../stores/server.js';
import { useThemeSync } from '../stores/theme.js';
import { useSettingsSync } from '../stores/settings-sync.js';
import { mountSystemEvents } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { SessionSidebar } from './sidebar/SessionSidebar.js';
import { ChatHeader } from './ChatHeader.js';
import { ChatHistory } from './history/ChatHistory.js';
import { ChatInput } from './input/ChatInput.js';
import { ChatActivityStrip } from './history/ChatActivityStrip.js';
import { ChatFrame } from './frame/ChatFrame.js';
import { useDockTabs } from './frame/dockTabs.js';

// ── ChatWindow ────────────────────────────────────────────────────────────────

export function ChatWindow(): JSX.Element {
  const viewedSessionId = useCurrentSession((s) => s.viewedSessionId);
  const serverStatus    = useServerStore((s) => s.status);
  const hasConnected    = useServerStore((s) => s.lastKnownPort !== null);

  useThemeSync();
  useSettingsSync(serverStatus.kind === 'ok');

  // Session metadata for title bar
  const session = useSessionStore((s) =>
    viewedSessionId ? s.sessions.byId.get(viewedSessionId as string) : undefined,
  );

  // 窗口 Dock："改动"入口把 review 开成标签。
  const openTab = useDockTabs((s) => s.openTab);

  // 聊天窗只消费主窗广播，不再自行建立全局 SSE 连接。
  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => {
    const stop = useServerStore.getState().startPolling();
    return stop;
  }, []);
  useEffect(() => {
    void (async () => {
      await useSessionStore.getState().loadSessions();
      if (!useCurrentSession.getState().viewedSessionId) {
        const { sessions } = useSessionStore.getState();
        const allSessions = [...sessions.pinned, ...sessions.recent];
        const best = allSessions.reduce<{ id: string; ts: number } | null>((prev, s) => {
          const ts = s.lastViewedAt ?? 0;
          return !prev || ts > prev.ts ? { id: s.id, ts } : prev;
        }, null);
        const pick = best?.id ?? sessions.recent[0]?.id ?? sessions.pinned[0]?.id;
        if (pick) void useCurrentSession.getState().viewSession(pick);
      }
    })();
  }, []);

  function openReview(): void {
    if (!viewedSessionId) return;
    openTab(viewedSessionId, { id: 'review', kind: 'review' });
  }

  if (serverStatus.kind === 'error' && !hasConnected) {
    return (
      <div className="flex items-center justify-center h-screen ema-fade-in text-[var(--ema-text-tertiary)]">
        <div className="text-center">
          <div className="text-lg mb-2 inline-flex items-center gap-1.5"><span className="i-lucide:unplug" aria-hidden />服务器离线</div>
          <div className="text-sm text-[var(--ema-text-tertiary)]">{serverStatus.reason}</div>
        </div>
      </div>
    );
  }

  if (!hasConnected && (serverStatus.kind === 'pending' || serverStatus.kind === 'unknown')) {
    return (
      <div className="flex items-center justify-center h-screen ema-fade-in text-[var(--ema-text-tertiary)]">
        连接中…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-row h-screen bg-[var(--ema-bg)]">
        <SessionSidebar />

        <ChatFrame
          sessionId={viewedSessionId}
          header={
            <>
              <ChatHeader
                sessionId={viewedSessionId}
                title={session?.title ?? (viewedSessionId ? '加载中…' : '无会话')}
                isFork={session?.forkedFromSessionId !== null && session?.forkedFromSessionId !== undefined}
              />
              {serverStatus.kind === 'error' && (
                <div
                  role="status"
                  className="flex items-center gap-2 px-4 py-2 border-b text-xs bg-[var(--ema-danger-muted)] border-[var(--ema-danger)]/30 text-[var(--ema-danger)]"
                >
                  <span className="i-lucide:unplug shrink-0" aria-hidden />
                  <span className="truncate">服务器暂时离线：{serverStatus.reason}</span>
                  <span className="ml-auto shrink-0 text-[var(--ema-text-tertiary)]">输入内容会保留</span>
                </div>
              )}
            </>
          }
          history={<ChatHistory />}
          activity={<ChatActivityStrip onOpenReview={openReview} />}
          input={<ChatInput />}
          statusBar={
            <div className="flex items-center justify-between px-4 py-1.5 border-t shrink-0 text-[11px] border-[var(--ema-border)] text-[var(--ema-text-tertiary)]">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverStatus.kind === 'ok' ? 'bg-[var(--ema-success)]' : 'bg-[var(--ema-danger)]'}`} />
                <span>服务器</span>
                {serverStatus.kind === 'ok' && (
                  <span className="text-[var(--ema-text-tertiary)]">{serverStatus.latencyMs}ms</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {viewedSessionId && (
                  <span className="font-mono opacity-40">{(viewedSessionId as string).slice(0, 8)}</span>
                )}
              </div>
            </div>
          }
        />
      </div>
    </ErrorBoundary>
  );
}
