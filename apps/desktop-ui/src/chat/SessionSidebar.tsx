import { useState, useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button, ConfirmDialog, DropdownMenu, Input, PromptDialog, type MenuItem } from '@ema-agent/ui';
import { sessionsApi, type SessionWire, type SessionSearchItem } from '../api/sessions.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore, type SessionsState } from '../stores/session-store.js';
import { useDecisionStore } from '../stores/decision-store.js';
import { runWithToast } from '../lib/toast.js';
import type { SessionId } from '@ema-agent/contracts';
import { WorkspacePicker } from './WorkspacePicker.js';

interface ProjectGroup {
  label: string;
  sessions: SessionWire[];
}

const sidebarBlockClass = 'flex items-center gap-2.5 h-9 px-2 rounded-md text-sm text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)] transition-[background-color,color] duration-150 ease-out';

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
                const newId = await useSessionStore.getState().createSession();
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

function NewConversationCommand({
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

function SidebarCommand({
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

function ProjectListSection({
  label, groups, viewedId, streaming, pendingCounts,
}: {
  label: string;
  groups: ProjectGroup[];
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const total = groups.reduce((sum, g) => sum + g.sessions.length, 0);
  const maxHeight = Math.min(900, total * 36 + groups.length * 34 + 12);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon="i-lucide:folders"
        count={groups.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
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
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
}): JSX.Element {
  const hasActive = group.sessions.some((s) => s.id === (viewedId as string));
  const [collapsed, setCollapsed] = useState(!hasActive);
  const maxHeight = Math.min(560, group.sessions.length * 38 + 6);

  useEffect(() => {
    if (hasActive) setCollapsed(false);
  }, [hasActive]);

  return (
    <div>
      <Button
        variant="ghost"
        className={`group/project w-full flex items-center gap-2 h-9 px-2 rounded-md text-sm transition-[background-color,color,box-shadow] duration-150 ease-out font-normal ${
          hasActive ? 'bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]' : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]'
        }`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`i-lucide:folder text-base ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`} aria-hidden />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <span className={`text-[11px] tabular-nums ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`}>{group.sessions.length}</span>
        <span className={`i-lucide:chevron-down text-xs ${hasActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'} transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
      </Button>
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
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

function SidebarSection({
  label, sessions, viewedId, streaming, pendingCounts, collapsed: initCollapsed = false, emptyText,
}: {
  label: string;
  sessions: SessionWire[];
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
  collapsed?: boolean;
  emptyText?: string;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(initCollapsed);
  const maxHeight = Math.min(760, Math.max(1, sessions.length) * 38 + 8);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon={label === '归档' ? 'i-lucide:archive' : 'i-lucide:message-circle'}
        count={sessions.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
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
      <span className={`i-lucide:chevron-right text-xs transition-transform duration-200 ease-out ${collapsed ? '' : 'rotate-90'} text-[var(--ema-text-tertiary)]`} aria-hidden />
    </Button>
  );
}

function AnimatedCollapse({
  open, maxHeight, children,
}: {
  open: boolean;
  maxHeight: number;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      className="overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out"
      style={{
        maxHeight: open ? maxHeight : 0,
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0)' : 'translateY(-3px)',
      }}
    >
      {children}
    </div>
  );
}

type StatusDot = { cls: string } | null;

function getStatusDot(
  session: SessionWire,
  streaming: Map<string, unknown>,
  pendingCounts: Record<string, number>,
): StatusDot {
  if (streaming.has(session.id)) return { cls: 'bg-[var(--ema-info)] animate-pulse' };
  if ((pendingCounts[session.id] ?? 0) > 0) return { cls: 'bg-[var(--ema-warning)] animate-pulse' };
  if (session.lastTurnStatus === 'failed' || session.lastTurnStatus === 'aborted') {
    return { cls: 'bg-[var(--ema-danger)]' };
  }
  if (session.hasUnread) return { cls: 'bg-[var(--ema-success)]' };
  return null;
}

function SidebarRow({ session, isActive, streaming, pendingCounts, nested = false }: {
  session:   SessionWire;
  isActive:  boolean;
  streaming: Map<string, unknown>;
  pendingCounts: Record<string, number>;
  nested?:   boolean;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [promptRename, setPromptRename] = useState(false);
  const [promptGroup,  setPromptGroup]  = useState(false);
  const dot = getStatusDot(session, streaming, pendingCounts);
  const isRunning = streaming.has(session.id);
  const timeLabel = formatRelativeTime(session.lastActivityAt);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消固定' : '固定',
      icon:     session.pinned ? 'i-lucide:pin-off' : 'i-lucide:pin',
      onSelect: () => void runWithToast(useSessionStore.getState().pinSession(session.id as SessionId, !session.pinned), '固定失败'),
    },
    {
      kind:     'item',
      label:    '重命名',
      icon:     'i-lucide:pencil',
      onSelect: () => setPromptRename(true),
    },
    {
      kind:     'item',
      label:    'Fork',
      icon:     'i-lucide:git-fork',
      onSelect: () => void (async () => {
        const newId = await useSessionStore.getState().forkSession(session.id as SessionId);
        void useConversationStore.getState().viewSession(newId);
      })(),
    },
    {
      kind:     'item',
      label:    '设置分组',
      icon:     'i-lucide:tag',
      onSelect: () => setPromptGroup(true),
    },
    {
      kind:     'item',
      label:    '工作区目录',
      icon:     'i-lucide:folder',
      onSelect: () => setShowWorkspace(true),
    },
    {
      kind:     'item',
      label:    '归档',
      icon:     'i-lucide:archive',
      onSelect: () => void runWithToast(useSessionStore.getState().archiveSession(session.id as SessionId), '归档失败'),
    },
    { kind: 'separator' },
    {
      kind:     'item',
      label:    '删除',
      icon:     'i-lucide:trash-2',
      danger:   true,
      onSelect: () => setPendingDelete(true),
    },
  ];

  function confirmDelete(): void {
    setPendingDelete(false);
    void runWithToast(useSessionStore.getState().deleteSession(session.id as SessionId), '删除失败');
  }

  return (
    <div
      className={`group relative flex items-center gap-1.5 h-9 pr-2 rounded-md text-sm cursor-pointer transition-[background-color,color,box-shadow] duration-150 ease-out ${
        nested ? 'pl-6' : 'pl-2'
      } ${
        isActive
          ? 'ema-active-rail bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-1)]'
          : 'text-[var(--ema-text-secondary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]'
      }`}
      onClick={() => void useConversationStore.getState().viewSession(session.id as SessionId)}
    >
      <span className="shrink-0 w-3 flex items-center justify-center">
        {dot ? (
          <span className={`w-1.5 h-1.5 rounded-full ${dot.cls}`} />
        ) : isRunning ? (
          <span className="flex gap-px">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-0.5 h-0.5 rounded-full animate-pulse bg-[var(--ema-text-secondary)]"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full border ${isActive ? 'border-[var(--ema-text-tertiary)]' : 'border-[var(--ema-border)]'}`} />
        )}
      </span>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {session.pinned && (
          <span className={`i-lucide:pin text-[11px] shrink-0 ${isActive ? 'text-[var(--ema-text-secondary)]' : 'text-[var(--ema-text-tertiary)]'}`} aria-hidden />
        )}
        <span className="truncate min-w-0 leading-snug">
          {session.title || '新对话'}
        </span>
        {(pendingCounts[session.id] ?? 0) > 0 && (
          <span
            className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full ema-scale-in bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)]"
            title={`${pendingCounts[session.id]} 个待答问题`}
          >
            {pendingCounts[session.id]}
          </span>
        )}
      </div>

      <div className="shrink-0 relative w-12 flex justify-end" onClick={(e) => e.stopPropagation()}>
        <span className={`text-[11px] tabular-nums transition-opacity text-[var(--ema-text-tertiary)] ${
          isActive ? 'opacity-0' : 'group-hover:opacity-0'
        }`}>
          {timeLabel}
        </span>
        <DropdownMenu
          trigger={
            <Button variant="ghost" className="absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 p-0 flex items-center justify-center rounded transition-[color,background-color,border-color] border bg-[var(--ema-surface-3)] border-[var(--ema-border)] text-[var(--ema-text-primary)] hover:bg-[var(--ema-primary-muted)] hover:border-[var(--ema-primary)]/40 font-normal">
              <span className="i-solar:menu-dots-bold-duotone text-xs" aria-hidden />
            </Button>
          }
          items={menuItems}
          side="right"
          align="start"
        />

        {showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setShowWorkspace(false)} />
            <WorkspacePicker session={session} positionClassName="left-full top-0 ml-1" onClose={() => setShowWorkspace(false)} />
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        message={`确定删除会话"${session.title || '新对话'}"？此操作不可撤销。`}
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(false)}
      />

      <PromptDialog
        open={promptRename}
        title="重命名会话"
        message="输入新的会话名称"
        initialValue={session.title}
        confirmText="重命名"
        onConfirm={(name) => { setPromptRename(false); if (name) void runWithToast(useSessionStore.getState().renameSession(session.id as SessionId, name), '重命名失败'); }}
        onCancel={() => setPromptRename(false)}
      />

      <PromptDialog
        open={promptGroup}
        title="设置分组"
        message="输入分组名称(留空取消分组)"
        initialValue={session.groupLabel ?? ''}
        confirmText="保存"
        onConfirm={(label) => { setPromptGroup(false); void runWithToast(useSessionStore.getState().setSessionGroup(session.id as SessionId, label.trim() || null), '分组失败'); }}
        onCancel={() => setPromptGroup(false)}
      />
    </div>
  );
}

function SessionSearchOverlay({
  recentSessions,
  onClose,
}: {
  recentSessions: SessionWire[];
  onClose(): void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SessionSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      sessionsApi.search({ q: trimmed, limit: 16 })
        .then((res) => {
          if (cancelled) return;
          setResults(rankSearchResults(trimmed, res.results));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 140);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const visibleResults = trimmed
    ? results
    : recentSessions.slice(0, 10).map(toRecentSearchItem);

  const selectSession = useCallback((id: string) => {
    void useConversationStore.getState().viewSession(id as SessionId);
    onClose();
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className="absolute left-1/2 top-14 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border overflow-hidden animate-scale-in shadow-[var(--ema-shadow-3)] bg-[var(--ema-surface-4)] border-[var(--ema-border)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-3" style={{ borderBottom: '1px solid var(--ema-border)' }}>
          <Input
            autoFocus
            inputSize="md"
            placeholder="搜索对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && visibleResults[0]) {
                selectSession(visibleResults[0].session.id);
              }
            }}
            className="text-[var(--ema-text-primary)] bg-[var(--ema-surface-2)] border-[var(--ema-border)]"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto p-1.5">
          <div className="px-2 py-1.5 text-xs text-[var(--ema-text-tertiary)]">
            {trimmed ? (loading ? '搜索中…' : '匹配结果') : '近期对话'}
          </div>

          {visibleResults.length === 0 && !loading ? (
            <div className="px-3 py-6 text-center text-sm text-[var(--ema-text-tertiary)]">
              没有匹配的对话
            </div>
          ) : visibleResults.map((hit) => (
            <SearchResultRow
              key={`${hit.session.id}:${hit.messageId ?? 'title'}`}
              item={hit}
              query={trimmed}
              onSelect={() => selectSession(hit.session.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SearchResultRow({
  item, query, onSelect,
}: {
  item: SessionSearchItem;
  query: string;
  onSelect(): void;
}): JSX.Element {
  const project = projectLabelFor(item.session);
  const snippet = item.snippet && item.snippet !== item.session.title
    ? item.snippet
    : '';

  return (
    <Button
      variant="ghost"
      className="w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors group text-[var(--ema-text-primary)] hover:bg-[var(--ema-surface-2)] font-normal"
      onClick={onSelect}
    >
      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
        item.matchKind === 'message' ? 'bg-[var(--ema-text-secondary)]' : 'bg-[var(--ema-text-tertiary)]'
      }`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--ema-text-primary)]">
          {item.session.title || '新对话'}
        </span>
        <span className="block truncate text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
          {snippet || (query ? '标题匹配' : formatRelativeTime(item.session.lastActivityAt))}
        </span>
      </span>
      <span className="shrink-0 max-w-28 truncate text-xs mt-0.5 text-[var(--ema-text-tertiary)]">
        {project}
      </span>
    </Button>
  );
}

// ── WorkspaceEditor ───────────────────────────────────────────────────────────
// (removed — replaced by the shared WorkspacePicker component)


function buildProjectGroups(sessions: SessionsState): ProjectGroup[] {
  const out: ProjectGroup[] = [];
  const used = new Set<string>();

  for (const g of sessions.byGroup) {
    const groupSessions = uniqueSessions(g.sessions);
    if (groupSessions.length === 0) continue;
    for (const s of groupSessions) used.add(s.id);
    out.push({ label: g.label, sessions: groupSessions });
  }

  const workspaceGroups = new Map<string, SessionWire[]>();
  for (const s of uniqueSessions([...sessions.pinned, ...sessions.recent])) {
    if (used.has(s.id)) continue;
    const root = s.workspaceRoot;
    if (!root) continue;
    const label = basename(root);
    const list = workspaceGroups.get(label) ?? [];
    list.push(s);
    workspaceGroups.set(label, list);
    used.add(s.id);
  }

  for (const [label, groupSessions] of workspaceGroups.entries()) {
    out.push({ label, sessions: uniqueSessions(groupSessions) });
  }

  return out;
}

function uniqueSessions(items: SessionWire[]): SessionWire[] {
  const seen = new Set<string>();
  const out: SessionWire[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function rankSearchResults(query: string, results: SessionSearchItem[]): SessionSearchItem[] {
  return [...results].sort((a, b) => {
    const sb = scoreSearchItem(query, b);
    const sa = scoreSearchItem(query, a);
    if (sb !== sa) return sb - sa;
    return b.session.lastActivityAt - a.session.lastActivityAt;
  });
}

function scoreSearchItem(query: string, item: SessionSearchItem): number {
  return fuzzyScore(query, item.session.title) * 1.45
    + fuzzyScore(query, item.snippet) * (item.matchKind === 'message' ? 1.1 : 0.55)
    + (item.session.pinned ? 0.08 : 0);
}

function fuzzyScore(query: string, target: string): number {
  const q = normaliseSearchText(query);
  const t = normaliseSearchText(target);
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.includes(q)) return 0.82 + Math.min(0.12, q.length / Math.max(t.length, 1));

  const subseq = subsequenceScore(q, t);
  const dice = diceCoefficient(q, t);
  return Math.max(subseq * 0.72, dice * 0.68);
}

function subsequenceScore(query: string, target: string): number {
  let qi = 0;
  let run = 0;
  let bestRun = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
      run++;
      bestRun = Math.max(bestRun, run);
    } else {
      run = 0;
    }
  }
  if (qi !== query.length) return 0;
  return (query.length / target.length) * 0.55 + (bestRun / query.length) * 0.45;
}

function diceCoefficient(a: string, b: string): number {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (aa.length === 0 || bb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const x of aa) counts.set(x, (counts.get(x) ?? 0) + 1);
  let hits = 0;
  for (const x of bb) {
    const n = counts.get(x) ?? 0;
    if (n <= 0) continue;
    hits++;
    counts.set(x, n - 1);
  }
  return (2 * hits) / (aa.length + bb.length);
}

function bigrams(value: string): string[] {
  if (value.length <= 1) return value ? [value] : [];
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2));
  return out;
}

function normaliseSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function toRecentSearchItem(session: SessionWire): SessionSearchItem {
  return {
    session,
    matchKind: 'title',
    snippet: '',
    messageId: null,
    messageAt: null,
  };
}

function projectLabelFor(session: SessionWire): string {
  return session.groupLabel
    ?? (session.workspaceRoot ? basename(session.workspaceRoot) : '对话');
}

function basename(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatRelativeTime(updatedAt: number): string {
  const diff = Math.max(0, Date.now() - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)}分`;
  if (diff < day) return `${Math.floor(diff / hour)}时`;
  if (diff < week) return `${Math.floor(diff / day)}天`;
  if (diff < month) return `${Math.floor(diff / week)}周`;
  return `${Math.floor(diff / month)}月`;
}
