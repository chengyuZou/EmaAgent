// 侧栏区块骨架:命令按钮、可折叠分区头、动画容器与会话/项目分区。
import { useEffect, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { SessionWire } from '../../api/sessions.js';

import type { ProjectGroup } from './sidebarGroups.js';
import { SidebarRow } from './SidebarRow.js';

const sidebarBlockClass = 'flex items-center gap-2.5 h-9 px-2 rounded-md text-sm text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)] transition-[background-color,color] duration-[var(--ema-duration-fast)] ease-[var(--ema-ease)]';

export function NewConversationCommand({
  onCreate, onCollapse,
}: {
  onCreate(): void | Promise<void>;
  onCollapse(): void;
}): JSX.Element {
  return (
    <div className={`w-full ${sidebarBlockClass} pr-1`}>
      <Button
        variant="ghost"
        className="min-w-0 flex flex-1 items-center gap-2.5 text-left font-normal"
        onClick={() => void onCreate()}
      >
        <span className="i-lucide:square-pen text-base text-[var(--ema-text-tertiary)]" aria-hidden />
        <span className="truncate">新对话</span>
      </Button>
      <Button
        variant="ghost"
        className="w-6 h-6 shrink-0 flex items-center justify-center rounded transition-colors border bg-[var(--ema-surface-3)] border-[var(--ema-border)] text-[var(--ema-text-primary)] hover:bg-[var(--ema-primary-muted)] hover:border-[var(--ema-primary)]/40 font-normal"
        onClick={onCollapse}
        title="折叠侧边栏"
        aria-label="折叠侧边栏"
      >
        <span className="i-lucide:panel-left text-[15px] shrink-0 leading-none" aria-hidden />
      </Button>
    </div>
  );
}

export function SidebarCommand({
  icon, label, onClick,
}: {
  icon: string;
  label: string;
  onClick(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`w-full ${sidebarBlockClass} font-normal`}
      onClick={onClick}
    >
      <span className={`${icon} text-base text-[var(--ema-text-tertiary)]`} aria-hidden />
      <span className="truncate">{label}</span>
    </Button>
  );
}

export function ProjectListSection({
  label, groups, viewedId, streaming, pendingCounts,
}: {
  label: string;
  groups: ProjectGroup[];
  viewedId: string | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon="i-lucide:folders"
        count={groups.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed}>
        <div className="flex flex-col gap-1 px-1.5 pb-1">
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[var(--ema-text-tertiary)]">暂无项目</p>
          ) : groups.map((g) => (
            <ProjectNode
              key={g.label}
              group={g}
              viewedId={viewedId}
              streaming={streaming}
              pendingCounts={pendingCounts}
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

function ProjectNode({
  group, viewedId, streaming, pendingCounts,
}: {
  group: ProjectGroup;
  viewedId: string | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
}): JSX.Element {
  const hasActive = group.sessions.some((s) => s.id === (viewedId as string));
  const [collapsed, setCollapsed] = useState(!hasActive);

  useEffect(() => {
    if (hasActive) setCollapsed(false);
  }, [hasActive]);

  return (
    <div>
      <Button
        variant="ghost"
        className={`group/project w-full flex items-center gap-2 h-9 px-2 rounded-md text-sm transition-[background-color,color,box-shadow] duration-[var(--ema-duration-fast)] ease-[var(--ema-ease)] font-normal ${
          hasActive ? 'bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]' : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]'
        }`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`i-lucide:folder text-base ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`} aria-hidden />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <span className={`text-[11px] tabular-nums ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`}>{group.sessions.length}</span>
        <span className={`i-lucide:chevron-down text-xs ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'} transition-transform duration-[var(--ema-duration-base)] ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
      </Button>
      <AnimatedCollapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 pt-0.5">
          {group.sessions.map((s) => (
            <SidebarRow
              key={s.id}
              session={s}
              isActive={s.id === (viewedId as string)}
              streaming={streaming}
              pendingCounts={pendingCounts}
              nested
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

export function SidebarSection({
  label, sessions, viewedId, streaming, pendingCounts, collapsed: initCollapsed = false, emptyText,
}: {
  label: string;
  sessions: SessionWire[];
  viewedId: string | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
  collapsed?: boolean;
  emptyText?: string;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(initCollapsed);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon={label === '归档' ? 'i-lucide:archive' : 'i-lucide:message-circle'}
        count={sessions.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 px-1.5 pb-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[var(--ema-text-tertiary)]">{emptyText ?? '暂无内容'}</p>
          ) : sessions.map((s) => (
            <SidebarRow
              key={s.id}
              session={s}
              isActive={s.id === (viewedId as string)}
              streaming={streaming}
              pendingCounts={pendingCounts}
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

function SectionHeader({
  label, icon, count, collapsed, onToggle,
}: {
  label: string;
  icon: string;
  count: number;
  collapsed: boolean;
  onToggle(): void;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      className={`${sidebarBlockClass} mx-1.5 mb-0.5 w-[calc(100%-0.75rem)] font-normal`}
      onClick={onToggle}
    >
      <span className={`${icon} text-base text-[var(--ema-text-tertiary)]`} aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-[var(--ema-text-tertiary)]">{count}</span>
      <span className={`i-lucide:chevron-right text-xs transition-transform duration-[var(--ema-duration-base)] ease-[var(--ema-ease)] ${collapsed ? '' : 'rotate-90'} text-[var(--ema-text-tertiary)]`} aria-hidden />
    </Button>
  );
}

function AnimatedCollapse({
  open, children,
}: {
  open: boolean;
  children: JSX.Element;
}): JSX.Element {
  // 双向折叠统一走 styles 的 .ema-collapsible(grid-rows 0fr↔1fr),不再自造 max-height 过渡。
  return (
    <div
      className="ema-collapsible"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
      }}
    >
      <div>{children}</div>
    </div>
  );
}
