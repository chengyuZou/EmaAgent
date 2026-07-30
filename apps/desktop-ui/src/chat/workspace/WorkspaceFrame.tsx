// Chat 工作区框架：MainRow(聊天列 + RightDock) + BottomDock、跨 Dock 保状态的标签池，
// 以及 RightDock 全宽展开模式下的 ChatInput 浮动条。
import { useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionId } from '@ema-agent/ids';
import { Button } from '@ema-agent/ui';
import { isRightFullWidth, useWorkspaceStore } from './workspaceStore.js';
import { WorkspaceDock } from './WorkspaceDock.js';
import type { WorkspaceTab } from './workspaceTypes.js';
import { ReviewPanel } from '../review/ReviewPanel.js';
import { FilesPanel } from '../FilesPanel.js';
import { SourcesPanel } from '../sources/SourcesPanel.js';
import { AgentRunPanel } from '../agentRuns/AgentRunPanel.js';
import { FilePreview } from '../FilePreview.js';

export interface WorkspaceFrameProps {
  sessionId: SessionId | null;
  header: ReactNode;
  history: ReactNode;
  activity: ReactNode;
  input: ReactNode;
  statusBar: ReactNode;
}

export function WorkspaceFrame({
  sessionId, header, history, activity, input, statusBar,
}: WorkspaceFrameProps): JSX.Element {
  const layout = useWorkspaceStore((s) =>
    sessionId ? s.layouts[sessionId as string] : undefined);
  const fullWidth = useWorkspaceStore((s) => isRightFullWidth(s, sessionId));
  const setFullWidth = useWorkspaceStore((s) => s.setFullWidth);

  // 内容容器元素（回调 ref 触发重渲染，portal 才能挂上）。
  const [rightEl, setRightEl] = useState<HTMLDivElement | null>(null);
  const [bottomEl, setBottomEl] = useState<HTMLDivElement | null>(null);
  const [columnHistoryEl, setColumnHistoryEl] = useState<HTMLDivElement | null>(null);
  const [columnInputEl, setColumnInputEl] = useState<HTMLDivElement | null>(null);
  const [floatHistoryEl, setFloatHistoryEl] = useState<HTMLDivElement | null>(null);
  const [floatInputEl, setFloatInputEl] = useState<HTMLDivElement | null>(null);

  // ChatInput 浮动条的展开/合上是当次状态（§3.5：不写布局记忆）。
  const [floatExpanded, setFloatExpanded] = useState(false);

  const pool = layout
    ? Object.values(layout.tabsById).map((tab) => {
        const dock = layout.rightTabOrder.includes(tab.id) ? 'right' as const
          : layout.bottomTabOrder.includes(tab.id) ? 'bottom' as const
          : null;
        if (!dock) return null;
        const target = dock === 'right' ? rightEl : bottomEl;
        if (!target) return null;
        const active = dock === 'right'
          ? layout.activeRightTabId === tab.id
          : layout.activeBottomTabId === tab.id;
        // 全部标签常驻各自 Dock，激活项显示、其余 hidden；
        // 跨 Dock 移动只换 portal 目标，组件实例不重建，内部状态保留。
        return createPortal(
          <div key={tab.id} className={active ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
            <WorkspaceTabContent
              tab={tab}
              sessionId={sessionId}
              onOpenFiles={sessionId ? () => useWorkspaceStore.getState().openTab(sessionId, { id: 'files', kind: 'files' }) : undefined}
            />
          </div>,
          target,
        );
      })
    : null;

  // ChatHistory / ChatInput 同一实例在两处位置间迁移（全宽 ⇄ 普通），
  // 与标签池同一 portal 模式：迁移即重挂，草稿经 store 保留。
  const historyPortal = fullWidth
    ? (floatExpanded && floatHistoryEl ? createPortal(history, floatHistoryEl) : null)
    : (columnHistoryEl ? createPortal(history, columnHistoryEl) : null);
  const inputPortal = fullWidth
    ? (floatInputEl ? createPortal(input, floatInputEl) : null)
    : (columnInputEl ? createPortal(input, columnInputEl) : null);

  return (
    <div className="relative flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex flex-row flex-1 min-h-0 min-w-0">
        <div className={`flex-col flex-1 min-w-0 min-h-0 ${fullWidth ? 'hidden' : 'flex'}`}>
          {header}
          <div ref={setColumnHistoryEl} className="flex-1 min-h-0 flex flex-col" />
          {activity}
          <div ref={setColumnInputEl} className="shrink-0" />
          {statusBar}
        </div>
        <WorkspaceDock
          sessionId={sessionId}
          dock="right"
          contentRef={setRightEl}
          fullWidth={fullWidth}
          {...(sessionId && !fullWidth && (layout?.rightTabOrder.length ?? 0) > 0
            ? { onExpandFullWidth: () => setFullWidth(sessionId, true) }
            : {})}
        />
      </div>
      <WorkspaceDock sessionId={sessionId} dock="bottom" contentRef={setBottomEl} />
      {pool}
      {historyPortal}
      {inputPortal}

      {/* ChatInput 浮动条：仅全宽模式；展开为悬浮聊天卡，合回输入条。 */}
      {fullWidth && (
        <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center pointer-events-none">
          <div className="pointer-events-auto w-[min(720px,92%)] pb-3 flex flex-col gap-1.5">
            {floatExpanded && (
              <div
                className="rounded-2xl border overflow-hidden ema-fade-in shadow-[var(--ema-shadow-3)] bg-[var(--ema-surface-1)] border-[var(--ema-border)]"
                style={{ height: '50vh' }}
              >
                <div ref={setFloatHistoryEl} className="h-full flex flex-col" />
              </div>
            )}
            <Button
              variant="ghost"
              className="self-center size-6 p-0 rounded-full flex items-center justify-center border shadow-[var(--ema-shadow-1)] bg-[var(--ema-surface-3)] border-[var(--ema-border)] text-[var(--ema-text-tertiary)]"
              onClick={() => setFloatExpanded((v) => !v)}
              title={floatExpanded ? '合上浮窗' : '展开聊天'}
            >
              <span className={`${floatExpanded ? 'i-lucide:chevron-down' : 'i-lucide:chevron-up'} text-xs`} aria-hidden />
            </Button>
            <div ref={setFloatInputEl} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── 标签内容注册表 ────────────────────────────────────────────────────────────
// 新能力获得真实运行时后在此登记；没有真实内容源的类型渲染明确说明，不伪造。

function WorkspaceTabContent({
  tab, sessionId, onOpenFiles,
}: {
  tab: WorkspaceTab;
  sessionId: SessionId | null;
  onOpenFiles?: () => void;
}): JSX.Element {
  switch (tab.kind) {
    case 'review':
      return <ReviewPanel sessionId={sessionId as string | null} />;
    case 'files':
      return <FilesPanel />;
    case 'file':
      return (
        <FilePreview
          path={tab.path}
          onBack={() => onOpenFiles?.()}
        />
      );
    case 'sources':
      return <SourcesPanel sessionId={sessionId as string | null} />;
    case 'agentRuns':
      return <AgentRunPanel className="p-2" />;
    case 'agentRun':
      return <AgentRunPanel className="p-2" initialDetailId={tab.agentRunId} />;
    case 'terminal':
    case 'browser':
      // E2 Terminal / E3 Browser 经用户拍板推迟到 V1 正式版(2026-07-30,内测不开放):
      // 类型与标签壳保留不删,启动器不提供入口;仅防御历史持久层残留或手工构造的标签,
      // 如实告知未实现,不渲染假能力。
      return <DeferredCapabilityNotice kind={tab.kind} />;
  }
}

function DeferredCapabilityNotice({ kind }: { kind: 'terminal' | 'browser' }): JSX.Element {
  const label = kind === 'terminal' ? '终端' : '浏览器';
  const icon = kind === 'terminal' ? 'i-lucide:terminal' : 'i-lucide:globe';
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className={`${icon} text-2xl opacity-40`} aria-hidden />
      <span>{label}功能暂未实现</span>
      <span className="opacity-70">将在 V1 正式版提供,内测版不开放</span>
    </div>
  );
}
