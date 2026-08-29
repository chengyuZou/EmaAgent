// Chat 工作区 Dock 的标签条：激活、关闭、右 ⇄ 底移动与新建入口。
import type { JSX } from 'react';

import { Button, DropdownMenu, IconButton } from '@ema-agent/ui';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useDockTabs } from './dockTabs.js';
import type { DockSide, DockTab } from './dockTabs.js';
import { closeTerminalSession } from './tabs/terminal/terminalSessions.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';

export function workspaceTabIcon(tab: DockTab): string {
  switch (tab.kind) {
    case 'review':    return 'i-lucide:file-diff';
    case 'files':     return 'i-solar:folder-bold-duotone';
    case 'file':      return 'i-mdi:file-outline';
    case 'draftAttachment': return 'i-lucide:paperclip';
    case 'attachment': return 'i-lucide:paperclip';
    case 'attachments': return 'i-lucide:paperclip';
    case 'tasks':     return 'i-lucide:list-checks';
    case 'agentRuns':
    case 'agentRun':  return 'i-solar:cpu-bold-duotone';
    case 'terminal':  return 'i-lucide:terminal';
    case 'browser':   return 'i-lucide:globe';
    case 'backgroundProcesses': return 'i-lucide:square-terminal';
  }
}

function baseTabLabel(tab: DockTab): string {
  switch (tab.kind) {
    case 'review':    return '审阅';
    case 'files':     return '文件';
    case 'file':      return tab.path.split('/').pop() ?? tab.path;
    case 'draftAttachment': return tab.attachment.name ?? tab.attachment.sourcePath.split(/[\\/]/).pop() ?? '附件';
    case 'attachment': return '附件';
    case 'attachments': return '附件';
    case 'tasks':     return '任务';
    case 'agentRuns': return '子智能体';
    case 'agentRun':  return '子智能体';
    case 'terminal':  return '终端';
    case 'browser':   return tab.title?.trim() || tab.url;
    case 'backgroundProcesses': return '后台进程';
  }
}

/** agentRun 标签优先显示执行目的，拿不到时回退通用名。 */
function AgentRunTabLabel({ agentRunId }: { agentRunId: string }): JSX.Element {
  const title = useAgentRunStore((s) => {
    const run = s.runs.get(agentRunId);
    return run?.description ?? run?.live?.promptExcerpt ?? null;
  });
  return <span className="truncate">{title ?? '子智能体'}</span>;
}

function AttachmentTabLabel({ sessionId, attachmentId }: { sessionId: string; attachmentId: string }): JSX.Element {
  const name = useSessionAttachmentStore(state =>
    state.bySession.get(sessionId)?.find(item => item.id === attachmentId)?.name,
  );
  return <span className="truncate">{name ?? '附件'}</span>;
}

export interface DockTabBarProps {
  sessionId: string;
  dock: DockSide;
  tabs: DockTab[];
  activeTabId?: string;
  onAdd(): void;
  /** RightDock 全宽展开；仅 Dock 展开且有内容时传入，按钮才渲染。 */
  onExpandFullWidth?: () => void;
}

export function DockTabBar({
  sessionId, dock, tabs, activeTabId, onAdd, onExpandFullWidth,
}: DockTabBarProps): JSX.Element {
  const closeTab     = useDockTabs((s) => s.closeTab);
  const activateTab  = useDockTabs((s) => s.activateTab);
  const moveTab      = useDockTabs((s) => s.moveTab);
  const moveTarget: DockSide = dock === 'right' ? 'bottom' : 'right';
  const close = (tab: DockTab): void => {
    if (tab.kind === 'terminal') void closeTerminalSession(tab.terminalId).catch(() => {});
    if (tab.kind === 'browser') void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
    closeTab(sessionId, tab.id);
  };

  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 shrink-0 overflow-x-auto border-b border-[var(--ema-border)]">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`group flex items-center gap-1 rounded-md pl-2 pr-0.5 py-1 shrink-0 max-w-44 transition-colors cursor-pointer ${
              active
                ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
                : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
            }`}
            onClick={() => activateTab(sessionId, tab.id)}
          >
            <span className={`${workspaceTabIcon(tab)} text-sm shrink-0`} aria-hidden />
            <span className="text-xs truncate">
              {tab.kind === 'agentRun'
                ? <AgentRunTabLabel agentRunId={tab.agentRunId} />
                : tab.kind === 'attachment'
                  ? <AttachmentTabLabel sessionId={sessionId} attachmentId={tab.attachmentId} />
                : baseTabLabel(tab)}
            </span>
            <DropdownMenu
              side="bottom"
              align="end"
              widthClass="min-w-36"
              trigger={
                <IconButton
                  size="sm"
                  label={`${baseTabLabel(tab)} 更多操作`}
                  icon="i-lucide:chevron-down"
                  className="opacity-0 group-hover:opacity-100"
                />
              }
              items={[
                {
                  kind: 'item',
                  label: moveTarget === 'bottom' ? '移到底部面板' : '移到右侧栏',
                  icon: moveTarget === 'bottom' ? 'i-lucide:arrow-down-to-line' : 'i-lucide:arrow-right-to-line',
                  onSelect: () => moveTab(sessionId, tab.id, moveTarget),
                },
                { kind: 'separator' },
                {
                  kind: 'item',
                  label: '关闭',
                  icon: 'i-lucide:x',
                  danger: true,
                  onSelect: () => close(tab),
                },
              ]}
            />
            <IconButton
              size="sm"
              label={`关闭${baseTabLabel(tab)}`}
              icon="i-lucide:x"
              className="opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                close(tab);
              }}
            />
          </div>
        );
      })}
      <IconButton size="sm" label="新建标签" icon="i-lucide:plus" onClick={onAdd} />
      {onExpandFullWidth !== undefined && (
        <IconButton
          size="sm"
          label="全宽展开"
          icon="i-lucide:maximize-2"
          onClick={onExpandFullWidth}
        />
      )}
    </div>
  );
}
