// Chat 工作区框架：MainRow(聊天列 + RightDock) + BottomDock、跨 Dock 保状态的标签池，
// 以及 RightDock 全宽展开模式下的 ChatInput 浮动条。
import { useCallback, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@ema-agent/ui';
import { isRightFullWidth, useDockTabs, type DockTab } from './dockTabs.js';
import { Dock } from './Dock.js';
import { ReviewPanel } from './tabs/review/ReviewPanel.js';
import { FilesPanel } from './tabs/files/FilesPanel.js';
import { SessionAttachmentsPanel } from './tabs/attachments/SessionAttachmentsPanel.js';
import { SessionTasksPanel } from './tabs/tasks/SessionTasksPanel.js';
import { AgentRunPanel } from './tabs/agentRuns/AgentRunPanel.js';
import { BackgroundProcessesPanel } from './tabs/processes/BackgroundProcessesPanel.js';
import { FilePreview } from './tabs/files/FilePreview.js';
import { SessionAttachmentPreview } from './tabs/files/SessionAttachmentPreview.js';
import { TerminalPanel } from './tabs/terminal/TerminalPanel.js';
import { BrowserPanel } from './tabs/browser/BrowserPanel.js';

export interface ChatFrameProps {
  sessionId: string | null;
  header: ReactNode;
  history: ReactNode;
  activity: ReactNode;
  input: ReactNode;
  statusBar: ReactNode;
}

export function ChatFrame({
  sessionId, header, history, activity, input, statusBar,
}: ChatFrameProps): JSX.Element {
  const layout = useDockTabs((s) =>
    sessionId ? s.layouts[sessionId] : undefined);
  const fullWidth = useDockTabs((s) => isRightFullWidth(s, sessionId));
  const setFullWidth = useDockTabs((s) => s.setFullWidth);

  // 内容容器元素（回调 ref 触发重渲染，portal 才能挂上）。
  const [rightEl, setRightEl] = useState<HTMLDivElement | null>(null);
  const [bottomEl, setBottomEl] = useState<HTMLDivElement | null>(null);
  const [columnHistoryEl, setColumnHistoryEl] = useState<HTMLDivElement | null>(null);
  const [columnInputEl, setColumnInputEl] = useState<HTMLDivElement | null>(null);
  const [floatHistoryEl, setFloatHistoryEl] = useState<HTMLDivElement | null>(null);
  const [floatInputEl, setFloatInputEl] = useState<HTMLDivElement | null>(null);

  // ChatInput 浮动条的展开/合上是当次状态，不写布局记忆。
  const [floatExpanded, setFloatExpanded] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState({ right: false, bottom: false });
  const onRightLauncherChange = useCallback((open: boolean) => {
    setLauncherOpen((state) => state.right === open ? state : { ...state, right: open });
  }, []);
  const onBottomLauncherChange = useCallback((open: boolean) => {
    setLauncherOpen((state) => state.bottom === open ? state : { ...state, bottom: open });
  }, []);

  const pool = layout
    ? Object.values(layout.tabsById).map((tab) => {
        const dock = layout.rightTabOrder.includes(tab.id) ? 'right' as const
          : layout.bottomTabOrder.includes(tab.id) ? 'bottom' as const
          : null;
        if (!dock) return null;
        const target = dock === 'right' ? rightEl : bottomEl;
        if (!target) return null;
        const active = !launcherOpen[dock] && (dock === 'right'
          ? layout.rightOpen && layout.activeRightTabId === tab.id
          : layout.bottomOpen && layout.activeBottomTabId === tab.id);
        // 全部标签常驻各自 Dock，激活项显示、其余 hidden；
        // 跨 Dock 移动只换 portal 目标，组件实例不重建，内部状态保留。
        return createPortal(
          <div key={tab.id} className={active ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
            <DockTabContent
              tab={tab}
              sessionId={sessionId}
              visible={active}
              onOpenFiles={sessionId ? () => useDockTabs.getState().openTab(sessionId, { id: 'files', kind: 'files' }) : undefined}
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
        <Dock
          sessionId={sessionId}
          dock="right"
          contentRef={setRightEl}
          fullWidth={fullWidth}
          {...(sessionId && !fullWidth && (layout?.rightTabOrder.length ?? 0) > 0
            ? { onExpandFullWidth: () => setFullWidth(sessionId, true) }
            : {})}
          onLauncherChange={onRightLauncherChange}
        />
      </div>
      <Dock
        sessionId={sessionId}
        dock="bottom"
        contentRef={setBottomEl}
        onLauncherChange={onBottomLauncherChange}
      />
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

function DockTabContent({
  tab, sessionId, visible, onOpenFiles,
}: {
  tab: DockTab;
  sessionId: string | null;
  visible: boolean;
  onOpenFiles?: () => void;
}): JSX.Element {
  switch (tab.kind) {
    case 'review':
      return <ReviewPanel sessionId={sessionId} />;
    case 'files':
      return <FilesPanel />;
    case 'file':
      return (
        <FilePreview
          path={tab.path}
          onBack={() => onOpenFiles?.()}
        />
      );
    case 'draftAttachment':
      return <FilePreview path={tab.attachment.sourcePath} onBack={() => onOpenFiles?.()} />;
    case 'attachment':
      return sessionId
        ? <SessionAttachmentPreview sessionId={sessionId} attachmentId={tab.attachmentId} />
        : <div className="p-3 text-xs text-[var(--ema-text-tertiary)]">请先选择会话</div>;
    case 'attachments':
      return <SessionAttachmentsPanel sessionId={sessionId} />;
    case 'tasks':
      return <SessionTasksPanel sessionId={sessionId} />;
    case 'backgroundProcesses':
      return <BackgroundProcessesPanel sessionId={sessionId} />;
    case 'agentRuns':
      return <AgentRunPanel sessionId={sessionId} className="p-2" />;
    case 'agentRun':
      return <AgentRunPanel sessionId={sessionId} className="p-2" initialDetailId={tab.agentRunId} />;
    case 'terminal':
      return <TerminalPanel terminalId={tab.terminalId} />;
    case 'browser':
      return sessionId
        ? <BrowserPanel sessionId={sessionId} browserId={tab.browserId} initialUrl={tab.url} visible={visible} />
        : <div className="p-3 text-xs text-[var(--ema-text-tertiary)]">请先选择会话</div>;
  }
}
