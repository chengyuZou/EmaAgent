import { useEffect, useState, useRef, type JSX } from 'react';
import type { SessionId } from '@ema-agent/contracts';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { useSidecarStore } from '../stores/sidecar-store.js';
import { useAgentTaskStore } from '../stores/agent-task-store.js';
import { useUiStore } from '../stores/ui-store.js';
import { useThemeSync } from '../stores/theme-store.js';
import { startSystemSse } from '../lib/system-sse.js';
import { ErrorBoundary } from '../lib/error-boundary.js';
import { SessionSidebar } from './SessionSidebar.js';
import { ChatHistory } from './ChatHistory.js';
import { ChatInput } from './ChatInput.js';
import { ContextPanel } from './ContextPanel.js';
import { TaskPanel } from './TaskPanel.js';
import { BranchPanel } from './BranchPanel.js';
import { ArtifactsPanel } from './ArtifactsPanel.js';
import { FilesPanel } from './FilesPanel.js';

// ── Inspector panel types ─────────────────────────────────────────────────────

type InspectorPanelId = 'branches' | 'artifacts' | 'files' | 'tasks';

// ── ChatPanel ─────────────────────────────────────────────────────────────────

export function ChatPanel(): JSX.Element {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const sidecarStatus   = useSidecarStore((s) => s.status);

  useThemeSync();

  const [activePanels, setActivePanels] = useState<Set<InspectorPanelId>>(new Set());
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Session metadata for title bar
  const session = useSessionStore((s) =>
    viewedSessionId ? s.sessions.byId.get(viewedSessionId as string) : undefined,
  );

  // Running task count badge on the ⋮ button
  const runningTaskCount = useAgentTaskStore((s) => {
    if (!viewedSessionId) return 0;
    return [...s.tasks.values()].filter(
      (t) => t.sessionId === viewedSessionId as string &&
             (t.status === 'running' || t.status === 'waiting_user'),
    ).length;
  });

  useEffect(() => { void startSystemSse(); }, []);
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

  function togglePanel(id: InspectorPanelId): void {
    setActivePanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasInspector = activePanels.size > 0;

  if (sidecarStatus.kind === 'error') {
    return (
      <div className="flex items-center justify-center h-screen ema-fade-in" style={{ color: 'var(--ema-text-tertiary)' }}>
        <div className="text-center">
          <div className="text-lg mb-2">⚡ Sidecar 离线</div>
          <div className="text-sm" style={{ color: 'var(--ema-text-tertiary)' }}>{sidecarStatus.reason}</div>
        </div>
      </div>
    );
  }

  if (sidecarStatus.kind === 'pending' || sidecarStatus.kind === 'unknown') {
    return (
      <div className="flex items-center justify-center h-screen ema-fade-in" style={{ color: 'var(--ema-text-tertiary)' }}>
        连接中…
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-row h-screen" style={{ background: 'var(--ema-bg)' }}>
        <SessionSidebar />

        {/* ── Main column ── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Title bar + inspector dock */}
          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0"
               style={{ borderColor: 'var(--ema-border)' }}>
            {/* Session title */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate" style={{ color: 'var(--ema-text-secondary)' }}>
                {session?.title ?? (viewedSessionId ? '加载中…' : '无会话')}
              </span>
              {session?.parentSessionId && (
                <span className="text-xs" style={{ color: 'var(--ema-text-tertiary)' }}>· 分支</span>
              )}
            </div>

            {/* Inspector dock */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* ⑂ Branches */}
              <InspectorDockBtn
                icon="i-mdi:source-fork"
                label="会话分支"
                active={activePanels.has('branches')}
                onClick={() => togglePanel('branches')}
              />
              {/* ▣ Artifacts */}
              <InspectorDockBtn
                icon="i-mdi:layers-outline"
                label="产物"
                active={activePanels.has('artifacts')}
                onClick={() => togglePanel('artifacts')}
              />
              {/* ⋮ Overflow */}
              <div className="relative" ref={overflowRef}>
                <button
                  className={`relative size-7 rounded-md flex items-center justify-center text-sm transition-colors
                    ${overflowOpen
                      ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                      : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]'}`}
                  onClick={() => setOverflowOpen((v) => !v)}
                  title="更多面板"
                >
                  <span className="i-mdi:dots-horizontal text-base" aria-hidden />
                  {runningTaskCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full text-[9px] font-bold px-0.5 pointer-events-none"
                          style={{ background: 'var(--ema-primary)', color: 'var(--ema-text-primary)' }}>
                      {runningTaskCount}
                    </span>
                  )}
                </button>

                {overflowOpen && (
                  <div className="ema-slide-up absolute top-full right-0 mt-1 z-50 w-44 rounded-xl border py-1 shadow-[var(--ema-shadow-3)]"
                       style={{ background: 'var(--ema-surface-4)', borderColor: 'var(--ema-border-hover)' }}>
                    <OverflowItem
                      icon="i-mdi:folder-outline"
                      label="文件浏览"
                      active={activePanels.has('files')}
                      onClick={() => { togglePanel('files'); setOverflowOpen(false); }}
                    />
                    <OverflowItem
                      icon="i-mdi:robot-outline"
                      label="后台任务"
                      active={activePanels.has('tasks')}
                      badge={runningTaskCount}
                      onClick={() => { togglePanel('tasks'); setOverflowOpen(false); }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          <ChatHistory />
          <ChatInput />

          {/* Status bar */}
          <div className="flex items-center justify-between px-4 py-1.5 border-t shrink-0 text-[11px]"
               style={{ borderColor: 'var(--ema-border)', color: 'var(--ema-text-tertiary)' }}>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sidecarStatus.kind === 'ok' ? 'bg-[var(--ema-success)]' : 'bg-[var(--ema-danger)]'}`} />
              <span>Sidecar</span>
              {sidecarStatus.kind === 'ok' && (
                <span style={{ color: 'var(--ema-text-tertiary)' }}>{sidecarStatus.latencyMs}ms</span>
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
        </div>

        {/* ── Right inspector panel ── */}
        {hasInspector && (
          <div
            className={`flex-none border-l flex flex-col overflow-hidden transition-[width] duration-200 ${activePanels.size > 1 ? 'w-[560px]' : 'w-72'}`}
            style={{ borderColor: 'var(--ema-border)', background: 'var(--ema-surface-1)' }}
          >
            <InspectorContent activePanels={activePanels} sessionId={viewedSessionId as string | null} />
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}

// ── Inspector dock helpers ────────────────────────────────────────────────────

function InspectorDockBtn({
  icon, label, active, badge, onClick,
}: {
  icon: string; label: string; active: boolean; badge?: number; onClick(): void;
}): JSX.Element {
  return (
    <button
      className={`relative size-7 rounded-md flex items-center justify-center text-sm transition-colors
        ${active
          ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)]'}`}
      onClick={onClick}
      title={label}
    >
      <span className={`${icon} text-base`} aria-hidden />
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full text-[9px] font-bold px-0.5 pointer-events-none"
              style={{ background: 'var(--ema-primary)', color: 'var(--ema-primary-text)' }}>
          {badge}
        </span>
      )}
    </button>
  );
}

function OverflowItem({
  icon, label, active, badge, onClick,
}: {
  icon: string; label: string; active: boolean; badge?: number; onClick(): void;
}): JSX.Element {
  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors
        ${active
          ? 'text-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-3)]'}`}
      onClick={onClick}
    >
      <span className={`${icon} text-base shrink-0`} aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      {badge != null && badge > 0 && (
        <span className="min-w-[18px] h-4 flex items-center justify-center rounded-full text-[10px] font-medium px-1"
              style={{ background: 'var(--ema-primary-muted)', color: 'var(--ema-primary)' }}>
          {badge}
        </span>
      )}
      {active && <span className="i-mdi:check text-sm shrink-0" style={{ color: 'var(--ema-primary)' }} aria-hidden />}
    </button>
  );
}

// ── Inspector content ─────────────────────────────────────────────────────────
//
// Grid rules (panels ordered by activation time):
//   1 panel  → full height, full width
//   2 panels → [A][B]         side-by-side
//   3 panels → [A][B] / [C  ] — C spans both columns
//   4 panels → [A][B] / [C][D]

function InspectorContent({
  activePanels, sessionId,
}: {
  activePanels: Set<InspectorPanelId>;
  sessionId:    string | null;
}): JSX.Element {
  const panels = [...activePanels]; // Set preserves insertion order
  const count  = panels.length;

  if (count === 0) return <></>;

  if (count === 1) {
    const id = panels[0]!;
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <InspectorPanelHeader id={id} />
        <div className="flex-1 overflow-hidden">
          <InspectorPanelBody id={id} sessionId={sessionId} />
        </div>
      </div>
    );
  }

  // 2-4: CSS grid — 2 columns, 1-2 rows
  const twoRows = count >= 3;
  return (
    <div
      className={`grid flex-1 min-h-0 grid-cols-2 ${twoRows ? 'grid-rows-2' : 'grid-rows-1'}`}
      style={{ borderColor: 'var(--ema-border)' }}
    >
      {panels.map((id, i) => {
        const colSpan = count === 3 && i === 2; // bottom panel spans both cols when only 3
        return (
          <div
            key={id}
            className={`flex flex-col min-h-0 overflow-hidden border-r border-b ${colSpan ? 'col-span-2' : ''}`}
            style={{ borderColor: 'var(--ema-border)' }}
          >
            <InspectorPanelHeader id={id} compact />
            <div className="flex-1 overflow-hidden">
              <InspectorPanelBody id={id} sessionId={sessionId} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PANEL_META: Record<InspectorPanelId, { label: string; icon: string }> = {
  branches:  { label: '会话分支', icon: 'i-mdi:source-fork' },
  artifacts: { label: '产物',     icon: 'i-mdi:layers-outline' },
  files:     { label: '文件',     icon: 'i-mdi:folder-outline' },
  tasks:     { label: '后台任务', icon: 'i-mdi:robot-outline' },
};

function InspectorPanelHeader({ id, compact }: { id: InspectorPanelId; compact?: boolean }): JSX.Element {
  const meta = PANEL_META[id];
  return (
    <div className={`flex items-center gap-1.5 px-3 shrink-0 border-b ${compact ? 'py-1.5' : 'py-2'}`}
         style={{ borderColor: 'var(--ema-border)' }}>
      <span className={`${meta.icon} text-sm`} style={{ color: 'var(--ema-text-tertiary)' }} aria-hidden />
      <span className={`font-medium ${compact ? 'text-xs' : 'text-sm'}`}
            style={{ color: 'var(--ema-text-secondary)' }}>
        {meta.label}
      </span>
    </div>
  );
}

function InspectorPanelBody({ id, sessionId }: { id: InspectorPanelId; sessionId: string | null }): JSX.Element {
  // key=id forces remount on panel switch → triggers ema-panel-in entrance
  const wrap = (child: JSX.Element): JSX.Element => (
    <div key={id} className="ema-panel-in h-full">{child}</div>
  );
  if (id === 'tasks')     return wrap(<TaskPanel className="p-2" />);
  if (id === 'branches')  return wrap(<BranchPanel />);
  if (id === 'artifacts') return wrap(<ArtifactsPanel />);
  if (id === 'files')     return wrap(<FilesPanel />);
  return <></>;
}

// ── Context ball ──────────────────────────────────────────────────────────────
// Small circular arc indicator showing live input token count vs context window.

const FALLBACK_CTX = 200_000;

// Stable empty reference — returning a fresh [] from a Zustand selector each
// render makes useSyncExternalStore loop ("Maximum update depth exceeded"),
// which is exactly what happens once the viewed session is deleted.
const EMPTY_MSGS: never[] = [];

function ContextBall({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  // Use the selected model's real context window; fall back to 200K if none selected.
  const selectedCtx = useUiStore((s) => s.selectedContextWindow);
  const ctxWindow = selectedCtx ?? FALLBACK_CTX;
  const isFallback = selectedCtx === null;

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
        <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
        <circle
          cx="9" cy="9" r={r} fill="none"
          stroke={color} strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <span style={{ color: 'var(--ema-text-tertiary)' }} className="tabular-nums">
        {fmtK(inputTok)}
      </span>
    </div>
  );
}
