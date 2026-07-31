// 会话侧栏主装配:折叠/宽度拖拽状态与分区数据推导,行、分区与搜索各自成文件。
import { useState, useCallback, useMemo, useRef, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@ema-agent/ui';
import { useConversationStore } from '../../stores/conversation-store.js';
import { useSessionStore } from '../../stores/session-store.js';
import { useDecisionStore } from '../../stores/decision-store.js';
import { runWithToast } from '../../lib/toast.js';
import { NewConversationCommand, ProjectListSection, SidebarCommand, SidebarSection } from './SidebarSections.js';
import { getStatusDot } from './SidebarRow.js';
import { SessionSearchOverlay } from './SidebarSearchOverlay.js';
import { buildProjectGroups, uniqueSessions } from './sidebarGroups.js';

export function SessionSidebar(): JSX.Element {
  const [collapsed, setCollapsed]   = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // 侧栏宽度(可拖拽,右边缘手柄)。默认 256px(w-64),范围 200-480。collapsed 时 w-10 不拖。
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [resizing, setResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  const onResizeStart = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    setResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartW.current = sidebarWidth;
    document.body.classList.add('ema-resizing');
    const onMove = (ev: MouseEvent): void => {
      // 手柄在右边缘,向右拖 = 增宽
      const delta = ev.clientX - resizeStartX.current;
      setSidebarWidth(Math.max(200, Math.min(480, resizeStartW.current + delta)));
    };
    const onUp = (): void => {
      setResizing(false);
      document.body.classList.remove('ema-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  const sessions  = useSessionStore((s) => s.sessions);
  const viewedId  = useConversationStore((s) => s.viewedSessionId);
  const streaming = useConversationStore((s) => s.streamingMap);
  const pendingCounts = useDecisionStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const [sid, q] of s.sessions) counts[sid as string] = q.length;
      return counts;
    }),
  );

  const allActiveSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.byGroup.flatMap((g) => g.sessions),
    ...sessions.recent,
  ]), [sessions]);

  const projectGroups = useMemo(() => buildProjectGroups(sessions), [sessions]);
  const projectSessionIds = useMemo(
    () => new Set(projectGroups.flatMap((g) => g.sessions.map((s) => s.id))),
    [projectGroups],
  );
  const conversationSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.recent,
  ]).filter((s) => !projectSessionIds.has(s.id)), [sessions, projectSessionIds]);

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
          onMouseDown={onResizeStart}
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
                  useConversationStore.getState().createFreshSession(),
                  '新建会话失败',
                );
                if (newId) void useConversationStore.getState().viewSession(newId);
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
