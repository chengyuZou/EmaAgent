import { useState, useMemo, type CSSProperties, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { SessionListItem } from '../../api/sessions.js';
import { useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionStore } from '../../stores/session.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useDragResize } from '../../hooks/use-drag-resize.js';
import { PinnedSection, ProjectSection } from './ProjectSection.js';
import { SessionList, SessionSearch } from './SessionList.js';
import { SidebarDragProvider } from './SidebarDragContext.js';

/** 同一会话可同时出现在置顶桶与项目桶; 搜索清单去重后保留原顺序. */
function uniqueSessions(items: readonly SessionListItem[]): SessionListItem[] {
  const seen = new Set<string>();
  const out: SessionListItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function SessionSidebar(): JSX.Element {
  const collapsed = !useMainNavigationStore(state => state.sidebarOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  // 折叠不丢弃拖拽后的宽度, 再展开时恢复同一个宽度.
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const { resizing, handleProps } = useDragResize({
    axis: 'x',
    sign: 1,
    getSize: () => sidebarWidth,
    setSize: setSidebarWidth,
    min: 200,
    max: 480,
  });

  const sessions  = useSessionStore((s) => s.sessions);
  const viewedId  = useMainNavigationStore((s) => s.viewedSessionId);
  const activityBySession = useSessionActivityStore((s) => s.bySession);

  const searchableSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.pinnedProjects.flatMap((project) => project.sessions),
    ...sessions.projects.flatMap((project) => project.sessions),
    ...sessions.recent,
  ]), [sessions]);

  return (
    <div
      className="ema-session-sidebar relative z-10 flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--ema-border)] bg-[var(--ema-sidebar-bg)]"
      data-collapsed={collapsed}
      data-resizing={resizing}
      aria-hidden={collapsed}
      ref={element => {
        if (element) {
          element.inert = collapsed;
        }
      }}
      style={{
        width: collapsed ? 0 : sidebarWidth,
        borderRightWidth: collapsed ? 0 : undefined,
        '--ema-sidebar-expanded-width': `${sidebarWidth}px`,
      } as CSSProperties}
    >
      {!collapsed && (
        <div
          className="ema-resize-handle"
          style={{ left: 'auto', right: 0 }}
          {...handleProps}
          aria-hidden
        />
      )}
      <div className="ema-session-sidebar-expanded flex h-full flex-col">
        <SidebarDragProvider>
          <div className="border-b border-[var(--ema-border)] px-1.5 py-2">
            <Button
              variant="ghost"
              className="ema-chat-bar-btn"
              onClick={() => useMainNavigationStore.getState().openNewSession()}
            >
              <span className="i-lucide:square-pen text-base" aria-hidden />
              <span className="truncate">新对话</span>
            </Button>
            <Button
              variant="ghost"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs text-[var(--ema-text-tertiary)] transition-colors hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
              onClick={() => setSearchOpen(true)}
            >
              <span className="i-lucide:search text-sm" aria-hidden />
              <span>搜索</span>
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto py-1.5" data-sidebar-scroll>
            <PinnedSection
              projects={sessions.pinnedProjects}
              sessions={sessions.pinned}
              viewedId={viewedId}
              activityBySession={activityBySession}
            />
            <ProjectSection
              projects={sessions.projects}
              viewedId={viewedId}
              activityBySession={activityBySession}
            />
            <SessionList
              label="对话"
              sessions={sessions.recent}
              viewedId={viewedId}
              activityBySession={activityBySession}
              emptyText="暂无独立对话"
              dropDestination={{ section: 'recent' }}
            />
          </div>
        </SidebarDragProvider>
      </div>
      {searchOpen && (
        <SessionSearch
          recentSessions={searchableSessions}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
