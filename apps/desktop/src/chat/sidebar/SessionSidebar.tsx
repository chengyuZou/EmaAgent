// 会话侧栏主装配:折叠/宽度拖拽状态;分区数据直接消费服务端五桶分组
// （置顶 Session / 置顶项目 / 其余项目 / 最近 / 已归档），行、分区与搜索各自成文件。
import { useState, useEffect, useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@ema-agent/ui';
import type { SessionListItem } from '../../api/sessions.js';
import { useCurrentSession } from '../state/currentSession.js';
import { useMessages } from '../state/messages.js';
import { useSessionStore } from '../../stores/session.js';
import { useDecisionStore } from '../../stores/decision.js';
import { runWithToast } from '../../lib/toast.js';
import { useDragResize } from '../../hooks/use-drag-resize.js';
import { NewConversationCommand, ProjectListSection, SidebarCommand, SidebarSection } from './SidebarSections.js';
import { getStatusDot } from './SidebarRow.js';
import { SessionSearchOverlay } from './SidebarSearchOverlay.js';

/** 同一会话可同时出现在置顶桶与项目桶；搜索覆盖层的近期清单合并展示前去重保序。 */
function uniqueSessions(items: readonly SessionListItem[]): SessionListItem[] {
  const seen = new Set<string>();
  const out: SessionListItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function SessionSidebar(): JSX.Element {
  const [collapsed, setCollapsed]   = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // 侧栏宽度(可拖拽,右边缘手柄)。默认 256px,范围 200-480。collapsed 时 w-10 不拖。
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const { resizing, handleProps } = useDragResize({
    axis: 'x',
    sign: 1,
    getSize: () => sidebarWidth,
    setSize: setSidebarWidth,
    min: 200,
    max: 480,
  });

  // 窄视口自动收成 rail；手动展开不受宽度限制，回到宽视口也不强行复原。
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setCollapsed(true);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const sessions  = useSessionStore((s) => s.sessions);
  const viewedId  = useCurrentSession((s) => s.viewedSessionId);
  const streaming = useMessages((s) => s.streamBySession);
  const pendingCounts = useDecisionStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const [sid, q] of s.sessions) counts[sid as string] = q.length;
      return counts;
    }),
  );

  const allActiveSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.pinnedProjects.flatMap((g) => g.sessions),
    ...sessions.projects.flatMap((g) => g.sessions),
    ...sessions.recent,
  ]), [sessions]);

  // 服务端分桶互斥：pinned 优先于项目成员资格，recent 只含无项目非置顶会话。
  const projectGroups = useMemo(
    () => [...sessions.pinnedProjects, ...sessions.projects],
    [sessions],
  );
  const conversationSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.recent,
  ]), [sessions]);

  return (
    <div className={`relative flex flex-col shrink-0 border-r h-full bg-[var(--ema-bg)] border-[var(--ema-border)] ${resizing ? '' : 'ema-transition-width'}`}
         style={{
           width: collapsed ? 40 : sidebarWidth,
         }}>
      {/* 拖拽手柄(右边缘)。展开态才显示,collapsed 不拖 */}
      {!collapsed && (
        <div
          className="ema-resize-handle"
          style={{ left: 'auto', right: 0 }}
          {...handleProps}
          aria-hidden
        />
      )}
      {collapsed ? (
        <div className="flex flex-col items-center py-2 gap-2">
          <Button
            variant="ghost"
            className="w-7 h-7 flex items-center justify-center rounded-md transition-colors border bg-[var(--ema-surface-3)] border-[var(--ema-border)] text-[var(--ema-text-primary)] hover:bg-[var(--ema-primary-muted)] hover:border-[var(--ema-primary)]/40 font-normal"
            onClick={() => setCollapsed(false)}
            title="展开侧边栏"
          >
            <span className="i-lucide:panel-right text-base shrink-0 leading-none" aria-hidden />
          </Button>
          <div className="flex flex-col items-center gap-1.5 mt-1">
            {sessions.recent.slice(0, 8).map((s) => {
              const dot = getStatusDot(s, streaming, pendingCounts);
              if (!dot) return null;
              return (
                <span
                  key={s.id}
                  className={`w-1.5 h-1.5 rounded-full ${dot.cls}`}
                  title={s.title}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="px-1.5 py-2 border-b border-[var(--ema-border)]">
            <NewConversationCommand
              onCreate={async () => {
                const newId = await runWithToast(
                  useCurrentSession.getState().createFreshSession(),
                  '新建会话失败',
                );
                if (newId) void useCurrentSession.getState().viewSession(newId);
              }}
              onCollapse={() => setCollapsed(true)}
            />
            <SidebarCommand
              icon="i-lucide:search"
              label="搜索"
              onClick={() => setSearchOpen(true)}
            />
          </div>

          <div className="flex-1 overflow-y-auto py-1.5">
            <ProjectListSection
              label="项目"
              groups={projectGroups}
              viewedId={viewedId}
              streaming={streaming}
              pendingCounts={pendingCounts}
            />
            <SidebarSection
              label="对话"
              sessions={conversationSessions}
              viewedId={viewedId}
              streaming={streaming}
              pendingCounts={pendingCounts}
              emptyText="暂无独立对话"
            />
            <SidebarSection
              label="归档"
              sessions={sessions.archived}
              viewedId={viewedId}
              streaming={streaming}
              pendingCounts={pendingCounts}
              collapsed
              emptyText="暂无归档"
            />
          </div>
        </>
      )}

      {searchOpen && (
        <SessionSearchOverlay
          recentSessions={allActiveSessions}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
