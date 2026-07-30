// Chat 工作区 Dock 的标签条：激活、关闭、右 ⇄ 底移动与新建入口。
import type { JSX } from 'react';
import type { SessionId } from '@ema-agent/ids';
import { Button, DropdownMenu, IconButton } from '@ema-agent/ui';
import { useAgentRunStore } from '../../stores/agentRunStore.js';
import { useWorkspaceStore } from './workspaceStore.js';
import type { WorkspaceDockId, WorkspaceTab } from './workspaceTypes.js';

export function workspaceTabIcon(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case 'review':    return 'i-lucide:file-diff';
    case 'files':     return 'i-solar:folder-bold-duotone';
    case 'file':      return 'i-mdi:file-outline';
    case 'sources':   return 'i-lucide:paperclip';
    case 'agentRuns':
    case 'agentRun':  return 'i-solar:cpu-bold-duotone';
    case 'terminal':  return 'i-lucide:terminal';
    case 'browser':   return 'i-lucide:globe';
  }
}

function baseTabLabel(tab: WorkspaceTab): string {
  switch (tab.kind) {
    case 'review':    return '审阅';
    case 'files':     return '文件';
    case 'file':      return tab.path.split('/').pop() ?? tab.path;
    case 'sources':   return '来源';
    case 'agentRuns': return '子智能体';
    case 'agentRun':  return '子智能体';
    case 'terminal':  return '终端';
    case 'browser':   return '浏览器';
  }
}

/** agentRun 标签优先显示执行目的，拿不到时回退通用名。 */
function AgentRunTabLabel({ agentRunId }: { agentRunId: string }): JSX.Element {
  const title = useAgentRunStore((s) => {
    const run = s.runs.get(agentRunId);
    return run?.purpose ?? run?.live?.promptExcerpt ?? null;
  });
  return <span className="truncate">{title ?? '子智能体'}</span>;
}

export interface WorkspaceTabBarProps {
  sessionId: SessionId;
  dock: WorkspaceDockId;
  tabs: WorkspaceTab[];
  activeTabId?: string;
  onAdd(): void;
}

export function WorkspaceTabBar({
  sessionId, dock, tabs, activeTabId, onAdd,
}: WorkspaceTabBarProps): JSX.Element {
  const closeTab     = useWorkspaceStore((s) => s.closeTab);
  const activateTab  = useWorkspaceStore((s) => s.activateTab);
  const moveTab      = useWorkspaceStore((s) => s.moveTab);
  const moveTarget: WorkspaceDockId = dock === 'right' ? 'bottom' : 'right';

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
                  onSelect: () => closeTab(sessionId, tab.id),
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
                closeTab(sessionId, tab.id);
              }}
            />
          </div>
        );
      })}
      <IconButton size="sm" label="新建标签" icon="i-lucide:plus" onClick={onAdd} />
    </div>
  );
}
