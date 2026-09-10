// 渲染 Project 分区, 项目行负责折叠与创建带 Project 预设的新对话.
import { useEffect, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { SessionProjectGroup } from '../../api/sessions.js';
import type { AgentSessionState } from '../../stores/agent.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { SessionRow } from './SessionRow.js';

interface ProjectGroupsProps {
  groups: SessionProjectGroup[];
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
}

export function ProjectGroups({
  groups,
  viewedId,
  agentSessions,
}: ProjectGroupsProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className="mb-1">
      <SectionButton
        label="项目"
        count={groups.length}
        collapsed={collapsed}
        onClick={() => setCollapsed((value) => !value)}
      />

      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-1 px-1.5 pb-1">
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[var(--ema-text-tertiary)]">
              暂无项目
            </p>
          ) : (
            groups.map((group) => (
              <ProjectGroup
                key={group.project.id}
                group={group}
                viewedId={viewedId}
                agentSessions={agentSessions}
              />
            ))
          )}
        </div>
      </Collapse>
    </section>
  );
}

export function ProjectGroup({
  group,
  viewedId,
  agentSessions,
}: {
  group: SessionProjectGroup;
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
}): JSX.Element {
  const active = group.sessions.some((session) => session.id === viewedId);
  const [collapsed, setCollapsed] = useState(!active);

  useEffect(() => {
    if (active) setCollapsed(false);
  }, [active]);

  return (
    <div>
      <Button
        variant="ghost"
        className={`group/project flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-normal ${
          active
            ? 'bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]'
            : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]'
        }`}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span
          className="i-lucide:folder text-base text-[var(--ema-text-tertiary)]"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-left">
          {group.project.name}
        </span>
        <button
          type="button"
          className="i-lucide:plus-circle rounded-full p-1 text-sm text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-primary)]"
          aria-label={`在 ${group.project.name} 中新建对话`}
          onClick={(event) => {
            event.stopPropagation();
            useChatWorkspace.getState().openNewSession(group.project.id);
          }}
        />
        <span className="text-[11px] tabular-nums text-[var(--ema-text-tertiary)]">
          {group.sessions.length}
        </span>
        <span
          className={`i-lucide:chevron-down text-xs transition-transform ${
            collapsed ? '-rotate-90' : ''
          }`}
          aria-hidden
        />
      </Button>

      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 pt-0.5">
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              isActive={session.id === viewedId}
              agentSessions={agentSessions}
              nested
            />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

export function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: JSX.Element;
}): JSX.Element {
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

interface SectionButtonProps {
  label: string;
  count: number;
  collapsed: boolean;
  onClick(): void;
  icon?: string;
}

export function SectionButton({
  label,
  count,
  collapsed,
  onClick,
  icon = 'i-lucide:folders',
}: SectionButtonProps): JSX.Element {
  return (
    <Button
      variant="ghost"
      className="mx-1.5 mb-0.5 flex h-9 w-[calc(100%-0.75rem)] items-center gap-2.5 rounded-md px-2 text-sm font-normal text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)]"
      onClick={onClick}
    >
      <span
        className={`${icon} text-base text-[var(--ema-text-tertiary)]`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="text-[11px] tabular-nums text-[var(--ema-text-tertiary)]">
        {count}
      </span>
      <span
        className={`i-lucide:chevron-right text-xs transition-transform ${
          collapsed ? '' : 'rotate-90'
        }`}
        aria-hidden
      />
    </Button>
  );
}
