// Chat 工作区框架：MainRow(聊天列 + RightDock) + BottomDock，以及跨 Dock 保状态的标签池。
import { useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionId } from '@ema-agent/ids';
import { useWorkspaceStore } from './workspaceStore.js';
import { WorkspaceDock } from './WorkspaceDock.js';
import type { WorkspaceTab } from './workspaceTypes.js';
import { ReviewPanel } from '../review/ReviewPanel.js';
import { FilesPanel } from '../FilesPanel.js';
import { SessionAttachmentsPanel } from '../SessionAttachmentsPanel.js';
import { AgentRunPanel } from '../agentRuns/AgentRunPanel.js';
import { FilePreview } from '../FilePreview.js';

export interface WorkspaceFrameProps {
  sessionId: SessionId | null;
  children: ReactNode;
}

export function WorkspaceFrame({ sessionId, children }: WorkspaceFrameProps): JSX.Element {
  const layout = useWorkspaceStore((s) =>
    sessionId ? s.layouts[sessionId as string] : undefined);
  const openTab = useWorkspaceStore((s) => s.openTab);

  // 内容容器元素（回调 ref 触发重渲染，portal 才能挂上）。
  const [rightEl, setRightEl] = useState<HTMLDivElement | null>(null);
  const [bottomEl, setBottomEl] = useState<HTMLDivElement | null>(null);

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
              onOpenFiles={sessionId ? () => openTab(sessionId, { id: 'files', kind: 'files' }) : undefined}
            />
          </div>,
          target,
        );
      })
    : null;

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex flex-row flex-1 min-h-0 min-w-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {children}
        </div>
        <WorkspaceDock sessionId={sessionId} dock="right" contentRef={setRightEl} />
      </div>
      <WorkspaceDock sessionId={sessionId} dock="bottom" contentRef={setBottomEl} />
      {pool}
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
      return <SessionAttachmentsPanel sessionId={sessionId as string | null} />;
    case 'agentRuns':
      return <AgentRunPanel className="p-2" />;
    case 'agentRun':
      return <AgentRunPanel className="p-2" initialExpandedId={tab.agentRunId} />;
    case 'terminal':
    case 'browser':
      // 启动器不提供这两类入口；仅防御历史持久层残留，不渲染假能力。
      return (
        <div className="flex-1 flex items-center justify-center text-xs text-[var(--ema-text-tertiary)]">
          该能力尚未接入当前版本
        </div>
      );
  }
}
