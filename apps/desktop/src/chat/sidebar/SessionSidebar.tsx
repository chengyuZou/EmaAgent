// 会话侧栏主装配:折叠/宽度拖拽状态;分区数据直接消费服务端五桶分组
// （置顶 Session / 置顶项目 / 其余项目 / 最近 / 已归档），行、分区与搜索各自成文件。
import { useState, useEffect, useMemo, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import type { SessionListItem } from '../../api/sessions.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { useSessionStore } from '../../stores/session.js';
import { useAgentStore } from '../../stores/agent.js';
import { useDragResize } from '../../hooks/use-drag-resize.js';
import { getStatusDot } from './SessionRow.js';
import { PinnedSection, ProjectSection } from './ProjectSection.js';
import { SessionList, SessionSearch } from './SessionList.js';
import { SidebarDragProvider } from './SidebarDragContext.js';

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
  const viewedId  = useChatWorkspace((s) => s.viewedSessionId);
  const agentSessions = useAgentStore((s) => s.sessions);

  const allActiveSessions = useMemo(() => uniqueSessions([
    ...sessions.pinned,
    ...sessions.pinnedProjects.flatMap((project) => project.sessions),
    ...sessions.projects.flatMap((project) => project.sessions),
    ...sessions.recent,
  ]), [sessions]);

  // 服务端分桶互斥：置顶 Session 独立展示，项目成员仍由对应项目行展示。

  useEffect(() => {
    const desired = new Set<string>();
    for (const session of allActiveSessions) {
      if (!session.hasActiveTurn && !agentSessions.get(session.id)?.execution && session.id !== viewedId) continue;
      desired.add(session.id);
      useAgentStore.getState().connectSession(session.id);
    }
    // Chat 只维持当前页和仍在执行的 Session. 切走的空闲 Session 不应永久占一条 WebSocket.
    for (const sessionId of agentSessions.keys()) {
      if (!desired.has(sessionId)) useAgentStore.getState().disconnectSession(sessionId);
    }
  }, [agentSessions, allActiveSessions, viewedId]);

  return (
    <div
      className={`relative flex h-full shrink-0 flex-col border-r bg-[var(--ema-bg)] border-[var(--ema-border)] ${
        resizing ? '' : 'ema-transition-width'
      }`}
      style={{ width: collapsed ? 40 : sidebarWidth }}
    >
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
            className="chat-icon-btn"
            onClick={() => setCollapsed(false)}
            title="展开侧边栏"
          >
            <span className="i-lucide:panel-right text-base shrink-0 leading-none" aria-hidden />
          </Button>
          <div className="flex flex-col items-center gap-1.5 mt-1">
            {sessions.recent.slice(0, 8).map((s) => {
              const dot = getStatusDot(s, agentSessions);
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
        <SidebarDragProvider>
          <div className="px-1.5 py-2 border-b border-[var(--ema-border)]">
            <div className="flex w-full items-center gap-2">
            <Button
              variant="ghost"
              className="chat-bar-btn"
              onClick={() => useChatWorkspace.getState().openNewSession()}
            >
              <span className="i-lucide:square-pen text-base" aria-hidden />
              <span className="truncate">新对话</span>
            </Button>
              <Button
                variant="ghost"
                className="flex size-6 shrink-0 items-center justify-center rounded border border-[var(--ema-border)] bg-[var(--ema-surface-3)] p-0"
                onClick={() => setCollapsed(true)}
                title="折叠侧边栏"
              >
                <span className="i-lucide:panel-left text-[15px]" aria-hidden />
              </Button>
            </div>
            <Button
              variant="ghost"
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs text-[var(--ema-text-tertiary)] transition-colors hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]"
              onClick={() => setSearchOpen(true)}
            >
              <span className="i-lucide:search text-sm" aria-hidden />
              <span>搜索</span>
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto py-1.5">
            <PinnedSection
              projects={sessions.pinnedProjects}
              sessions={sessions.pinned}
              viewedId={viewedId}
              agentSessions={agentSessions}
            />
            <ProjectSection
              projects={sessions.projects}
              viewedId={viewedId}
              agentSessions={agentSessions}
            />
            <SessionList
              label="对话"
              sessions={sessions.recent}
              viewedId={viewedId}
              agentSessions={agentSessions}
              emptyText="暂无独立对话"
              dropDestination={{ section: 'recent' }}
            />
            <SessionList
              label="归档"
              sessions={sessions.archived}
              viewedId={viewedId}
              agentSessions={agentSessions}
              initiallyCollapsed
              emptyText="暂无归档"
            />
          </div>
        </SidebarDragProvider>
      )}

      {searchOpen && (
        <SessionSearch
          recentSessions={allActiveSessions}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
