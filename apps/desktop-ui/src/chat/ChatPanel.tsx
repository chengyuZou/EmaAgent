// 组装会话侧栏、消息历史、输入区与工作区 Dock，并维护聊天窗口生命周期。
import { useEffect, useState, useRef, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { SessionId } from '@ema-agent/ids';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useSidecarStore } from '../stores/sidecar-store.js';
import { useAgentRunStore } from '../stores/agentRunStore.js';
import { findEnabledModel, useModelCatalogStore } from '../stores/model-catalog-store.js';
import { useThemeSync } from '../stores/theme-store.js';
import { useRuntimeSettingsSync } from '../stores/runtime-settings-sync.js';
import { mountSystemEvents } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { SessionSidebar } from './SessionSidebar.js';
import { ChatHistory } from './history/ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { ContextPanel } from './ContextPanel.js';
import { ChatActivityStrip } from './activity/ChatActivityStrip.js';
import { WorkspaceFrame } from './workspace/WorkspaceFrame.js';
import { useWorkspaceStore } from './workspace/workspaceStore.js';

// ── ChatPanel ─────────────────────────────────────────────────────────────────

export function ChatPanel(): JSX.Element {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const sidecarStatus   = useSidecarStore((s) => s.status);
  const hasConnected    = useSidecarStore((s) => s.lastKnownPort !== null);

  useThemeSync();
  useRuntimeSettingsSync(sidecarStatus.kind === 'ok');

  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Session metadata for title bar
  const session = useSessionStore((s) =>
    viewedSessionId ? s.sessions.byId.get(viewedSessionId as string) : undefined,
  );

  // Running task count badge on the ⋮ button
  const runningAgentRunCount = useAgentRunStore((s) => {
    if (!viewedSessionId) return 0;
    return [...s.runs.values()].filter(
      (run) => run.sessionId === viewedSessionId as string &&
               run.status === 'running',
    ).length;
  });

  // 工作区 Dock：⋮ 菜单与"改动"入口都把资源开成标签。
  const openTab = useWorkspaceStore((s) => s.openTab);
  const workspaceLayout = useWorkspaceStore((s) =>
    viewedSessionId ? s.layouts[viewedSessionId as string] : undefined);
  const hasWorkspaceTab = (tabId: string): boolean =>
    workspaceLayout?.tabsById[tabId] !== undefined;

  function openWorkspaceTab(tab: 'sources' | 'files' | 'agentRuns' | 'review'): void {
    if (!viewedSessionId) return;
    switch (tab) {
      case 'sources':   openTab(viewedSessionId, { id: 'sources', kind: 'sources' }); break;
      case 'files':     openTab(viewedSessionId, { id: 'files', kind: 'files' }); break;
      case 'agentRuns': openTab(viewedSessionId, { id: 'agentRuns', kind: 'agentRuns' }); break;
      case 'review':    openTab(viewedSessionId, { id: 'review', kind: 'review' }); break;
    }
    setOverflowOpen(false);
  }

  // 聊天窗只消费主窗广播，不再自行建立全局 SSE 连接。
  useEffect(() => mountSystemEvents({ ownsConnection: false }), []);
  useEffect(() => {
    const stop = useSidecarStore.getState().startPolling();
    return stop;
  }, []);
  useEffect(() => {
    void (async () => {
      await useSessionStore.getState().loadSessions();
      if (!useConversationStore.getState().viewedSessionId) {
        const { sessions } = useSessionStore.getState();
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

  // Close overflow when clicking outside
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent): void => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [overflowOpen]);

  function openReview(): void {
    if (!viewedSessionId) return;
    openTab(viewedSessionId, { id: 'review', kind: 'review' });
  }

  if (sidecarStatus.kind === 'error' && !hasConnected) {
    return (
      <div className="flex items-center justify-center h-screen ema-fade-in text-[var(--ema-text-tertiary)]">
        <div className="text-center">
          <div className="text-lg mb-2 inline-flex items-center gap-1.5"><span className="i-lucide:unplug" aria-hidden />Sidecar 离线</div>
          <div className="text-sm text-[var(--ema-text-tertiary)]">{sidecarStatus.reason}</div>
        </div>
      </div>
    );
  }

  if (!hasConnected && (sidecarStatus.kind === 'pending' || sidecarStatus.kind === 'unknown')) {
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

        <WorkspaceFrame sessionId={viewedSessionId}>
          {/* Title bar + workspace entries */}
          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0 border-[var(--ema-border)]">
            {/* Session title */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate text-[var(--ema-text-secondary)]">
                {session?.title ?? (viewedSessionId ? '加载中…' : '无会话')}
              </span>
              {session?.parentSessionId && (
                <span className="text-xs text-[var(--ema-text-tertiary)]">· 会话副本</span>
              )}
            </div>

            {/* Workspace ⋮ menu */}
            <div className="flex items-center gap-0.5 shrink-0">
              <div className="relative" ref={overflowRef}>
                <Button
                  variant="ghost"
                  className={`relative size-7 p-0 rounded-md flex items-center justify-center text-sm transition-colors
                    ${overflowOpen
                      ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                      : 'text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]'}`}
                  onClick={() => setOverflowOpen((v) => !v)}
                  title="工作区"
                >
                  <span className="i-solar:menu-dots-bold-duotone text-base shrink-0" aria-hidden />
                  {runningAgentRunCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full text-[9px] font-bold px-0.5 pointer-events-none bg-[var(--ema-primary)] text-[var(--ema-text-primary)]">
                      {runningAgentRunCount}
                    </span>
                  )}
                </Button>

                {overflowOpen && (
                  <div className="ema-slide-up absolute top-full right-0 mt-1 z-50 w-44 rounded-xl border p-1 shadow-[var(--ema-shadow-3)] bg-[var(--ema-surface-4)] border-[var(--ema-border-hover)]">
                    <OverflowItem
                      icon="i-lucide:paperclip"
                      label="来源"
                      active={hasWorkspaceTab('sources')}
                      onClick={() => openWorkspaceTab('sources')}
                    />
                    <OverflowItem
                      icon="i-solar:folder-bold-duotone"
                      label="文件浏览"
                      active={hasWorkspaceTab('files')}
                      onClick={() => openWorkspaceTab('files')}
                    />
                    <OverflowItem
                      icon="i-solar:cpu-bold-duotone"
                      label="子智能体"
                      active={hasWorkspaceTab('agentRuns')}
                      badge={runningAgentRunCount}
                      onClick={() => openWorkspaceTab('agentRuns')}
                    />
                    <OverflowItem
                      icon="i-lucide:file-diff"
                      label="审阅"
                      active={hasWorkspaceTab('review')}
                      onClick={() => openWorkspaceTab('review')}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {sidecarStatus.kind === 'error' && (
            <div
              role="status"
              className="flex items-center gap-2 px-4 py-2 border-b text-xs bg-[var(--ema-danger-muted)] border-[var(--ema-danger)]/30 text-[var(--ema-danger)]"
            >
              <span className="i-lucide:unplug shrink-0" aria-hidden />
              <span className="truncate">Sidecar 暂时离线：{sidecarStatus.reason}</span>
              <span className="ml-auto shrink-0 text-[var(--ema-text-tertiary)]">输入内容会保留</span>
            </div>
          )}

          <ChatHistory />
          <ChatActivityStrip onOpenReview={openReview} />
          <ChatInput />

          {/* Status bar */}
          <div className="flex items-center justify-between px-4 py-1.5 border-t shrink-0 text-[11px] border-[var(--ema-border)] text-[var(--ema-text-tertiary)]">
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sidecarStatus.kind === 'ok' ? 'bg-[var(--ema-success)]' : 'bg-[var(--ema-danger)]'}`} />
              <span>Sidecar</span>
              {sidecarStatus.kind === 'ok' && (
                <span className="text-[var(--ema-text-tertiary)]">{sidecarStatus.latencyMs}ms</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <ContextBall sessionId={viewedSessionId as string | null} />
              <ContextPanel />
              {viewedSessionId && (
                <span className="font-mono opacity-40">{(viewedSessionId as string).slice(0, 8)}</span>
              )}
            </div>
          </div>
        </WorkspaceFrame>
      </div>
    </ErrorBoundary>
  );
}

// ── Workspace ⋮ menu item ───────────────────────────────────────────────────────

function OverflowItem({
  icon, label, active, badge, onClick,
}: {
  icon: string; label: string; active: boolean; badge?: number; onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-normal rounded-lg transition-colors
        ${active
          ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-3)]'}`}
      onClick={onClick}
    >
      <span className={`${icon} text-base shrink-0`} aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      {badge != null && badge > 0 && (
        <span className="min-w-[18px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-1 bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]">
          {badge}
        </span>
      )}
      {active && <span className="i-lucide:check text-sm shrink-0 text-[var(--ema-primary)]" aria-hidden />}
    </Button>
  );
}

// ── Context ball ──────────────────────────────────────────────────────────────
// Small circular arc indicator showing live input token count vs context window.

const FALLBACK_CTX = 200_000;

// Stable empty reference — returning a fresh [] from a Zustand selector each
// render makes useSyncExternalStore loop ("Maximum update depth exceeded"),
// which is exactly what happens once the viewed session is deleted.
const EMPTY_MSGS: never[] = [];

function ContextBall({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const session = useSessionStore((state) =>
    sessionId ? state.sessions.byId.get(sessionId) : undefined,
  );
  const models = useModelCatalogStore((state) => state.models);
  const preferredModel = findEnabledModel(
    models,
    session?.preferredProviderConfigId,
    session?.preferredModelId,
  );
  // 上下文上限来自当前 Session 的模型目录，不再读取跨 Session 的全局 UI 状态。
  const ctxWindow = preferredModel?.contextWindow ?? FALLBACK_CTX;
  const isFallback = preferredModel === undefined;

  const streaming = useConversationStore((s) =>
    sessionId ? s.streamingMap.get(sessionId) : undefined,
  );
  const liveUsage = useConversationStore((s) => {
    if (!streaming?.turnId) return undefined;
    return s.liveUsageMap.get(streaming.turnId as string);
  });

  const messages = useConversationStore((s) =>
    sessionId ? s.messages.get(sessionId) ?? EMPTY_MSGS : EMPTY_MSGS,
  );
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.stats);
  const inputTok = liveUsage?.inputTokens ?? lastAssistant?.stats?.inputTokens ?? 0;

  if (!inputTok) return null;

  const pct = Math.min(inputTok / ctxWindow, 1);
  const r   = 7;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;

  const color = pct > 0.8 ? 'var(--ema-danger)' : pct > 0.5 ? 'var(--ema-warning)' : 'var(--ema-success)';

  function fmtK(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  return (
    <div className="flex items-center gap-1.5"
         title={`上下文: ${fmtK(inputTok)} / ${fmtK(ctxWindow)} (${Math.round(pct * 100)}%)${isFallback ? ' · 选择模型后显示精确上限' : ''}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--ema-surface-3)" strokeWidth="2.5" />
        <circle
          cx="9" cy="9" r={r} fill="none"
          stroke={color} strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-[var(--ema-duration-slow)] ease-[var(--ema-ease)]"
        />
      </svg>
      <span className="text-[var(--ema-text-tertiary)] tabular-nums">
        {fmtK(inputTok)}
      </span>
    </div>
  );
}
