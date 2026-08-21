// 组装会话侧栏、消息历史、输入区与工作区 Dock，并维护聊天窗口生命周期。
import { useEffect, type JSX } from 'react';

import { Popover } from '@ema-agent/ui';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { useSidecarStore } from '../../stores/sidecar-store.js';
import { useContextUsageStore } from '../../stores/contextUsageStore.js';
import { findEnabledModel, useModelCatalogStore } from '../../stores/model-catalog-store.js';
import { useThemeSync } from '../../stores/theme-store.js';
import { useRuntimeSettingsSync } from '../../stores/runtime-settings-sync.js';
import { mountSystemEvents } from '../../lib/system-sse.js';
import { ErrorBoundary } from '../../lib/error-boundary.js';
import { SessionSidebar } from '../sidebar/SessionSidebar.js';
import { ChatHeader } from '../ChatHeader.js';
import { ChatHistory } from '../history/ChatHistory.js';
import { ChatInput } from '../input/ChatInput.js';
import { ContextPanel } from '../ContextPanel.js';
import { ChatActivityStrip } from '../activity/ChatActivityStrip.js';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';

// ── ChatPanel ─────────────────────────────────────────────────────────────────

export function ChatPanel(): JSX.Element {
  const viewedSessionId = useConversationStore((s) => s.viewedSessionId);
  const sidecarStatus   = useSidecarStore((s) => s.status);
  const hasConnected    = useSidecarStore((s) => s.lastKnownPort !== null);

  useThemeSync();
  useRuntimeSettingsSync(sidecarStatus.kind === 'ok');

  // Session metadata for title bar
  const session = useSessionStore((s) =>
    viewedSessionId ? s.sessions.byId.get(viewedSessionId as string) : undefined,
  );

  // 工作区 Dock："改动"入口把 review 开成标签。
  const openTab = useWorkspaceStore((s) => s.openTab);

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
        if (pick) void useConversationStore.getState().viewSession(pick);
      }
    })();
  }, []);

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

        <WorkspaceFrame
          sessionId={viewedSessionId}
          header={
            <>
              <ChatHeader
                sessionId={viewedSessionId}
                title={session?.title ?? (viewedSessionId ? '加载中…' : '无会话')}
                isFork={session?.parentSessionId !== null && session?.parentSessionId !== undefined}
              />
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
            </>
          }
          history={<ChatHistory />}
          activity={<ChatActivityStrip onOpenReview={openReview} />}
          input={<ChatInput />}
          statusBar={
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
          }
        />
      </div>
    </ErrorBoundary>
  );
}

// ── Context ball ──────────────────────────────────────────────────────────────
// Small circular arc indicator showing live input token count vs context window.
// 真实用量优先,首轮真实未到时回退批1估算(带 ~);点击弹出分类明细。

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
  const realInput = liveUsage?.inputTokens ?? lastAssistant?.stats?.inputTokens;

  const estimateEntry = useContextUsageStore((s) =>
    sessionId ? s.bySession[sessionId] : undefined,
  );
  const estimate = estimateEntry?.estimate;
  // 真实未到时用估算撑场;窗口上限同样优先取估算自带的精确值。
  const effectiveWindow = estimate?.contextWindow ?? ctxWindow;
  const inputTok = realInput ?? estimate?.totalTokens ?? 0;
  const isEstimate = realInput === undefined && estimate !== undefined;

  if (!inputTok) return null;

  const pct = Math.min(inputTok / effectiveWindow, 1);
  const r   = 7;
  const circ = 2 * Math.PI * r;
  const dash = pct * circ;

  const color = pct > 0.8 ? 'var(--ema-danger)' : pct > 0.5 ? 'var(--ema-warning)' : 'var(--ema-success)';

  function fmtK(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  const categoryRows = estimate
    ? (Object.entries(estimate.categories) as Array<[string, number]>)
        .map(([key, tokens]) => ({ key, label: CATEGORY_LABELS[key] ?? key, tokens }))
        .filter((row) => row.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
    : [];

  return (
    <Popover
      side="top"
      align="end"
      widthClass="w-64"
      trigger={
        <span className="flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-[var(--ema-surface-2)]">
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
            {isEstimate ? `~${fmtK(inputTok)}` : fmtK(inputTok)}
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-1.5 p-1">
        <p className="text-xs font-medium text-[var(--ema-text-secondary)]">
          上下文 {fmtK(inputTok)} / {fmtK(effectiveWindow)}({Math.round(pct * 100)}%)
        </p>
        {categoryRows.length > 0 ? (
          categoryRows.map((row) => (
            <div key={row.key} className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--ema-text-tertiary)]">{row.label}</span>
              <span className="tabular-nums text-[var(--ema-text-secondary)]">~{fmtK(row.tokens)}</span>
            </div>
          ))
        ) : (
          <p className="text-[10px] text-[var(--ema-text-tertiary)]">本轮还没有分类估算。</p>
        )}
        <div className="border-t mt-1 pt-1.5 border-[var(--ema-border)]">
          {realInput !== undefined ? (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--ema-text-tertiary)]">本轮真实消耗</span>
              <span className="tabular-nums text-[var(--ema-text-primary)]">
                {fmtK(realInput)} Input{liveUsage ? ` · ${fmtK(liveUsage.outputTokens)} Output` : ''}
              </span>
            </div>
          ) : (
            <p className="text-[10px] text-[var(--ema-text-tertiary)]">
              ~ 为估算值;真实消耗以 Provider 返回为准,回合结束后计入用量统计。
            </p>
          )}
        </div>
      </div>
    </Popover>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  systemPrompt: '系统指令',
  toolInstructions: '工具说明书',
  toolSchemas: '工具定义',
  workspaceInstructions: '工作区规则',
  skills: '技能',
  memory: '记忆',
  narrative: '剧情',
  messages: '消息',
  attachments: '附件媒体',
  other: '其他',
};
