// 组装当前 Session 的右侧标签页, 标签生命周期由 sessionPanel Store 维护.
import { useEffect, useState, type JSX } from 'react';
import { nanoid } from 'nanoid';
import { Button, IconButton } from '@ema-agent/ui';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcess.js';
import { useSessionStore } from '../../stores/session.js';
import { browserTab, terminalTab, useSessionPanelStore, type SessionSidePanelTab } from '../../stores/sessionPanel.js';
import { SubagentPanel } from './tabs/subagents/SubagentPanel.js';
import { SessionAttachmentPreview } from './tabs/sources/SessionAttachmentPreview.js';
import { SessionAttachmentsPanel } from './tabs/sources/SessionAttachmentsPanel.js';
import { BrowserPanel } from './tabs/browser/BrowserPanel.js';
import { FilesPanel } from './tabs/files/FilesPanel.js';
import { BackgroundProcessesPanel } from './tabs/processes/BackgroundProcessesPanel.js';
import { ReviewPanel } from './tabs/review/ReviewPanel.js';
import { SessionTasksPanel } from './tabs/tasks/SessionTasksPanel.js';
import { GoalPanel } from './tabs/goal/goalPanel.js';
import { TerminalPanel } from './tabs/terminal/TerminalPanel.js';
import { closeTerminalSession, startTerminal } from './tabs/terminal/terminalSessions.js';

const LAUNCHER_TABS: readonly SessionSidePanelTab[] = [
  { id: 'review', kind: 'review' },
  { id: 'files', kind: 'files' },
  { id: 'subagents', kind: 'subagents' },
  { id: 'sources', kind: 'sources' },
];

function tabIcon(tab: SessionSidePanelTab): string {
  switch (tab.kind) {
    case 'review':
      return 'i-lucide:file-diff';
    case 'files':
      return 'i-lucide:folder';
    case 'file':
      return 'i-lucide:file';
    case 'source':
    case 'sources':
      return 'i-lucide:paperclip';
    case 'tasks':
      return 'i-lucide:list-checks';
    case 'goal':
      return 'i-lucide:goal';
    case 'subagents':
      return 'i-lucide:cpu';
    case 'terminal':
      return 'i-lucide:terminal';
    case 'browser':
      return 'i-lucide:globe';
    case 'processes':
    case 'process':
      return 'i-lucide:square-terminal';
  }
}

function baseLabel(tab: SessionSidePanelTab): string {
  switch (tab.kind) {
    case 'review':
      return '审阅';
    case 'files':
      return '打开文件';
    case 'file':
      return tab.path.split(/[\\/]/).pop() ?? tab.path;
    case 'source':
      return '附件';
    case 'sources':
      return '附件';
    case 'tasks':
      return '任务';
    case 'goal':
      return '编辑目标';
    case 'subagents':
      return '子智能体';
    case 'terminal':
      return '终端';
    case 'browser':
      return tab.title?.trim() || tab.url || '新标签页';
    case 'processes':
      return '后台进程';
    case 'process':
      return '后台进程';
  }
}

function TabLabel({ sessionId, tab }: { sessionId: string; tab: SessionSidePanelTab }): JSX.Element {
  const sourceTitle = useSessionAttachmentStore((state) => {
    if (tab.kind !== 'source') {
      return undefined;
    }
    const source = state.bySession.get(sessionId)?.find(item => item.path === tab.path);
    if (!source) {
      return undefined;
    }
    if (source.kind === 'image') {
      return source.name ?? '剪贴板图片';
    }
    return '粘贴文本';
  });
  const processTitle = useBackgroundProcessStore((state) => {
    if (tab.kind !== 'process') {
      return undefined;
    }
    return state.listsBySession.get(sessionId)?.processes
      .find((process) => process.id === tab.backgroundProcessId)?.description
      ?? state.listsBySession.get(sessionId)?.processes
        .find((process) => process.id === tab.backgroundProcessId)?.command;
  });
  return <>{sourceTitle ?? processTitle ?? baseLabel(tab)}</>;
}

function TabBar({
  sessionId,
  tabs,
  activeTabId,
  onActivate,
  onAdd,
}: {
  sessionId: string;
  tabs: readonly SessionSidePanelTab[];
  activeTabId?: string;
  onActivate(tabId: string): void;
  onAdd(): void;
}): JSX.Element {
  const closeTab = useSessionPanelStore((state) => state.closeTab);

  function close(tab: SessionSidePanelTab): void {
    if (tab.kind === 'terminal') {
      void closeTerminalSession(tab.terminalId).catch(() => { });
    }
    closeTab(sessionId, tab.id);
  }

  return (
    <div className="ema-workspace-tab-bar shrink-0 border-b border-[var(--ema-border)] px-2 py-1.5">
      <div className="ema-tab-slot min-w-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div key={tab.id} data-selected={tab.id === activeTabId || undefined} className="ema-slot-tab group">
            <button
              type="button"
              className="ema-slot-tab-trigger"
              title={baseLabel(tab)}
              onClick={() => onActivate(tab.id)}
            >
              <span
                className={`${tabIcon(tab)} shrink-0 text-[16px]`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                <TabLabel sessionId={sessionId} tab={tab} />
              </span>
            </button>
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              label={`关闭${baseLabel(tab)}`}
              icon="i-lucide:x"
              className="ema-slot-tab-close"
              onClick={() => close(tab)}
            />
          </div>
        ))}
        <IconButton
          size="sm"
          variant="ghost"
          shape="rounded"
          label="新建标签"
          icon="i-lucide:plus"
          onClick={onAdd}
        />
      </div>
    </div>
  );
}

function Launcher({ sessionId, onClose }: { sessionId: string; onClose?: () => void }): JSX.Element {
  const openTab = useSessionPanelStore((state) => state.openTab);
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!onClose) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="ema-workspace-launcher ema-fade-in">
      <div className="ema-workspace-launcher-content">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-medium text-[var(--ema-text-secondary)]">工具</h2>
          {onClose && (
            <IconButton
              size="sm"
              variant="ghost"
              shape="rounded"
              label="返回当前标签"
              icon="i-lucide:x"
              onClick={onClose}
            />
          )}
        </div>
        <div className="ema-workspace-launcher-grid">
          {LAUNCHER_TABS.map((tab) => (
            <Button
              key={tab.id}
              variant="ghost"
              className="ema-workspace-launcher-action"
              onClick={() => {
                openTab(sessionId, tab);
                onClose?.();
              }}
            >
              <span
                className={`${tabIcon(tab)} shrink-0 text-[16px] text-[var(--ema-text-tertiary)]`}
                aria-hidden
              />
              {baseLabel(tab)}
            </Button>
          ))}

          <Button
            variant="ghost"
            disabled={openingTerminal || !cwd}
            className="ema-workspace-launcher-action"
            onClick={() => {
              if (!cwd) {
                return;
              }
              const terminalId = nanoid();
              setOpeningTerminal(true);
              setError(null);

              void startTerminal({ terminalId, sessionId, cwd })
                .then(() => {
                  openTab(sessionId, terminalTab(terminalId));
                  onClose?.();
                })
                .catch((cause) => {
                  setError(cause instanceof Error ? cause.message : '终端打开失败');
                })
                .finally(() => setOpeningTerminal(false));
            }}
          >
            <span className="i-lucide:terminal shrink-0 text-[16px] text-[var(--ema-text-tertiary)]" aria-hidden />
            {openingTerminal ? '正在打开终端…' : '终端'}
          </Button>

          <Button
            variant="ghost"
            className="ema-workspace-launcher-action"
            onClick={() => {
              const browserId = nanoid();
              openTab(sessionId, browserTab(browserId));
              onClose?.();
            }}
          >
            <span className="i-lucide:globe shrink-0 text-[16px] text-[var(--ema-text-tertiary)]" aria-hidden />
            浏览器
          </Button>
        </div>
        {error && (
          <div className="mt-3 text-[12px] text-[var(--ema-danger)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionSidePanel({ sessionId }: { sessionId: string }): JSX.Element {
  const layout = useSessionPanelStore((state) => state.layouts[sessionId]);
  const activateTab = useSessionPanelStore((state) => state.activateTab);
  const [launcherOpen, setLauncherOpen] = useState(false);
  useEffect(() => setLauncherOpen(false), [sessionId]);
  const tabs = (layout?.tabOrder ?? [])
    .map((id) => layout?.tabsById[id])
    .filter((tab) => tab !== undefined);
  const hasFileTabs = tabs.some(tab => tab.kind === 'files' || tab.kind === 'file');
  const activeTab = layout?.activeTabId ? layout.tabsById[layout.activeTabId] : undefined;
  const filesVisible = Boolean(layout?.open) && !launcherOpen
    && (activeTab?.kind === 'files' || activeTab?.kind === 'file');

  return (
    <div className="ema-session-side-panel ema-chat-content-surface relative flex h-full min-w-0 flex-col overflow-hidden">
      {tabs.length > 0 && (
        <TabBar
          sessionId={sessionId}
          tabs={tabs}
          activeTabId={layout?.activeTabId}
          onActivate={(tabId) => {
            activateTab(sessionId, tabId);
            setLauncherOpen(false);
          }}
          onAdd={() => setLauncherOpen(true)}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabs.length === 0 && <Launcher sessionId={sessionId} />}
        {launcherOpen && tabs.length > 0 && (
          <Launcher sessionId={sessionId} onClose={() => setLauncherOpen(false)} />
        )}
        {/* 文件标签共用一个浏览器; 首次替换空白标签也不卸载目录模型. */}
        {hasFileTabs && (
          <div className={filesVisible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <FilesPanel key={sessionId} sessionId={sessionId} />
          </div>
        )}
        {tabs.filter(tab => tab.kind !== 'files' && tab.kind !== 'file').map(tab => {
          const visible = Boolean(layout?.open) && !launcherOpen && tab.id === layout?.activeTabId;
          return (
            <div key={tab.id} className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <TabContent sessionId={sessionId} tab={tab} visible={visible} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TabContent({ sessionId, tab, visible }: { sessionId: string; tab: SessionSidePanelTab; visible: boolean }): JSX.Element {
  switch (tab.kind) {
    case 'review':
      return <ReviewPanel sessionId={sessionId} />;
    case 'files':
    case 'file':
      return <></>;
    case 'source':
      return (
        <SessionAttachmentPreview sessionId={sessionId} attachmentPath={tab.path} />
      );
    case 'sources':
      return <SessionAttachmentsPanel sessionId={sessionId} />;
    case 'tasks':
      return <SessionTasksPanel sessionId={sessionId} />;
    case 'goal':
      return <GoalPanel sessionId={sessionId} goalId={tab.id} />;
    case 'processes':
      return <BackgroundProcessesPanel sessionId={sessionId} />;
    case 'process':
      return (
        <BackgroundProcessesPanel sessionId={sessionId} backgroundProcessId={tab.backgroundProcessId} />
      );
    case 'subagents':
      return (
        <SubagentPanel sessionId={sessionId} initialDetailId={tab.subagentId} />
      );
    case 'terminal':
      return <TerminalPanel terminalId={tab.terminalId} />;
    case 'browser':
      return (
        <BrowserPanel
          sessionId={sessionId}
          browserId={tab.browserId}
          url={tab.url}
          visible={visible}
        />
      );
  }
}
