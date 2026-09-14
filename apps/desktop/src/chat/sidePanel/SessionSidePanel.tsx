// 组装当前 Session 的右侧标签页, 标签生命周期由 chatWorkspace 统一维护.
import { useEffect, useState, type JSX } from 'react';
import { nanoid } from 'nanoid';
import { Button, IconButton } from '@ema-agent/ui';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import {
  browserTab,
  terminalTab,
  useSessionSidePanel,
  type SessionSidePanelTab,
} from '../state/chatWorkspace.js';
import { AgentRunPanel } from './tabs/subagents/AgentRunPanel.js';
import { SessionAttachmentPreview } from './tabs/sources/SessionAttachmentPreview.js';
import { SessionAttachmentsPanel } from './tabs/sources/SessionAttachmentsPanel.js';
import { BrowserPanel } from './tabs/browser/BrowserPanel.js';
import { FilePreview } from './tabs/files/FilePreview.js';
import { FilesPanel } from './tabs/files/FilesPanel.js';
import { BackgroundProcessesPanel } from './tabs/processes/BackgroundProcessesPanel.js';
import { ReviewPanel } from './tabs/review/ReviewPanel.js';
import { SessionTasksPanel } from './tabs/tasks/SessionTasksPanel.js';
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
      return 'i-solar:folder-bold-duotone';
    case 'file':
      return 'i-mdi:file-outline';
    case 'source':
    case 'sources':
      return 'i-lucide:paperclip';
    case 'tasks':
      return 'i-lucide:list-checks';
    case 'subagents':
      return 'i-solar:cpu-bold-duotone';
    case 'terminal':
      return 'i-lucide:terminal';
    case 'browser':
      return 'i-lucide:globe';
    case 'processes':
      return 'i-lucide:square-terminal';
  }
}

function baseLabel(tab: SessionSidePanelTab): string {
  switch (tab.kind) {
    case 'review':
      return '审阅';
    case 'files':
      return '文件';
    case 'file':
      return tab.path.split(/[\\/]/).pop() ?? tab.path;
    case 'source':
      return '附件';
    case 'sources':
      return '附件';
    case 'tasks':
      return '任务';
    case 'subagents':
      return '子智能体';
    case 'terminal':
      return '终端';
    case 'browser':
      return tab.title?.trim() || tab.url || '新标签页';
    case 'processes':
      return '后台进程';
  }
}

function TabLabel({
  sessionId,
  tab,
}: {
  sessionId: string;
  tab: SessionSidePanelTab;
}): JSX.Element {
  const sourceTitle = useSessionAttachmentStore((state) => {
    if (tab.kind !== 'source') return undefined;
    const source = state.bySession.get(sessionId)?.find(item => item.path === tab.path);
    return source?.kind === 'image' ? source.name ?? '剪贴板图片' : source ? '粘贴文本' : undefined;
  });
  return <>{sourceTitle ?? baseLabel(tab)}</>;
}

function TabBar({
  sessionId,
  tabs,
  activeTabId,
  onAdd,
}: {
  sessionId: string;
  tabs: readonly SessionSidePanelTab[];
  activeTabId?: string;
  onAdd(): void;
}): JSX.Element {
  const closeTab = useSessionSidePanel((state) => state.closeTab);
  const activateTab = useSessionSidePanel((state) => state.activateTab);

  function close(tab: SessionSidePanelTab): void {
    if (tab.kind === 'terminal') void closeTerminalSession(tab.terminalId).catch(() => {});
    closeTab(sessionId, tab.id);
  }

  return (
    <div className="shrink-0 border-b border-[var(--ema-border)] px-1.5 py-1.5">
      <div className="ema-tab-slot min-w-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            data-selected={tab.id === activeTabId || undefined}
            className="ema-slot-tab group flex max-w-44 shrink-0 cursor-pointer items-center gap-1 py-1 pl-2 pr-0.5 text-[var(--ema-text-secondary)]"
            onClick={() => activateTab(sessionId, tab.id)}
          >
            <span className={`${tabIcon(tab)} shrink-0 text-sm`} aria-hidden />
            <span className="truncate text-xs">
              <TabLabel sessionId={sessionId} tab={tab} />
            </span>
            <IconButton
              size="sm"
              label={`关闭${baseLabel(tab)}`}
              icon="i-lucide:x"
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                close(tab);
              }}
            />
          </div>
        ))}
        <IconButton size="sm" label="新建标签" icon="i-lucide:plus" onClick={onAdd} />
      </div>
    </div>
  );
}

function Launcher({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose?: () => void;
}): JSX.Element {
  const openTab = useSessionSidePanel((state) => state.openTab);
  const cwd = useSessionStore(state => state.sessions.byId.get(sessionId)?.cwd);
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!onClose) return;

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const menu = (
    <div className="flex w-52 flex-col gap-0.5 rounded-xl border border-[var(--ema-border-hover)] bg-[var(--ema-surface-4)] p-1.5 shadow-[var(--ema-shadow-3)]">
      {LAUNCHER_TABS.map((tab) => (
        <Button
          key={tab.id}
          variant="ghost"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs text-[var(--ema-text-secondary)] hover:bg-[var(--ema-primary-muted)] hover:text-[var(--ema-primary-text)]"
          onClick={() => {
            openTab(sessionId, tab);
            onClose?.();
          }}
        >
          <span
            className={`${tabIcon(tab)} text-base text-[var(--ema-text-tertiary)]`}
            aria-hidden
          />
          {baseLabel(tab)}
        </Button>
      ))}

      <Button
        variant="ghost"
        disabled={openingTerminal || !cwd}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs text-[var(--ema-text-secondary)] hover:bg-[var(--ema-primary-muted)] hover:text-[var(--ema-primary-text)]"
        onClick={() => {
          if (!cwd) return;
          const terminalId = nanoid();
          setOpeningTerminal(true);
          setError(null);

          void startTerminal({
            terminalId,
            sessionId,
            cwd,
          })
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
        <span
          className="i-lucide:terminal text-base text-[var(--ema-text-tertiary)]"
          aria-hidden
        />
        {openingTerminal ? '正在打开终端…' : '终端'}
      </Button>

      <Button
        variant="ghost"
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs text-[var(--ema-text-secondary)] hover:bg-[var(--ema-primary-muted)] hover:text-[var(--ema-primary-text)]"
        onClick={() => {
          const browserId = nanoid();
          openTab(sessionId, browserTab(browserId));
          onClose?.();
        }}
      >
        <span
          className="i-lucide:globe text-base text-[var(--ema-text-tertiary)]"
          aria-hidden
        />
        浏览器
      </Button>

      {error && (
        <div className="px-3 py-1 text-[11px] text-[var(--ema-danger)]">
          {error}
        </div>
      )}
    </div>
  );

  if (!onClose) {
    return (
      <div className="flex flex-1 items-center justify-center ema-fade-in">
        {menu}
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--ema-mask)] ema-fade-in"
      onClick={onClose}
    >
      <div onClick={(event) => event.stopPropagation()}>{menu}</div>
    </div>
  );
}

export function SessionSidePanel({
  sessionId,
}: {
  sessionId: string;
}): JSX.Element {
  const layout = useSessionSidePanel((state) => state.layouts[sessionId]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  useEffect(() => setLauncherOpen(false), [sessionId]);
  const tabs = (layout?.tabOrder ?? [])
    .map((id) => layout?.tabsById[id])
    .filter((tab) => tab !== undefined);

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--ema-surface-1)]">
      {tabs.length > 0 && (
        <TabBar
          sessionId={sessionId}
          tabs={tabs}
          activeTabId={layout?.activeTabId}
          onAdd={() => setLauncherOpen(true)}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tabs.length === 0 && <Launcher sessionId={sessionId} />}
        {tabs.map(tab => {
          const visible = !launcherOpen && tab.id === layout?.activeTabId;
          return (
            <div
              key={tab.id}
              className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
            >
              <TabContent sessionId={sessionId} tab={tab} visible={visible} />
            </div>
          );
        })}
      </div>
      {launcherOpen && (
        <Launcher sessionId={sessionId} onClose={() => setLauncherOpen(false)} />
      )}
    </div>
  );
}

function TabContent({
  sessionId,
  tab,
  visible,
}: {
  sessionId: string;
  tab: SessionSidePanelTab;
  visible: boolean;
}): JSX.Element {
  const openFiles = (): void => {
    useSessionSidePanel.getState().openTab(sessionId, { id: 'files', kind: 'files' });
  };

  switch (tab.kind) {
    case 'review':
      return <ReviewPanel sessionId={sessionId} />;
    case 'files':
      return <FilesPanel />;
    case 'file':
      return <FilePreview path={tab.path} onBack={openFiles} />;
    case 'source':
      return (
        <SessionAttachmentPreview sessionId={sessionId} attachmentPath={tab.path} />
      );
    case 'sources':
      return <SessionAttachmentsPanel sessionId={sessionId} />;
    case 'tasks':
      return <SessionTasksPanel sessionId={sessionId} />;
    case 'processes':
      return <BackgroundProcessesPanel sessionId={sessionId} />;
    case 'subagents':
      return <AgentRunPanel sessionId={sessionId} className="p-2" />;
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
