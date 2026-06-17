import { useState, useCallback, useEffect, useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DropdownMenu, Input, type MenuItem } from '@ema-agent/ui';
import { sessionsApi, type SessionWire, type SessionSearchItem } from '../api/sessions.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore, type SessionsState } from '../stores/session-store.js';
import { useDecisionStore } from '../stores/decision-store.js';
import type { SessionId } from '@ema-agent/contracts';

interface ProjectGroup {
  label: string;
  sessions: SessionWire[];
}

const sidebarBlockClass = 'flex items-center gap-2.5 h-9 px-2 rounded-md text-sm text-neutral-300 hover:text-neutral-50 hover:bg-neutral-900/90 transition-[background-color,color] duration-150 ease-out';

export function SessionSidebar(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const sessions  = useSessionStore((s) => s.sessions);
  const viewedId  = useConversationStore((s) => s.viewedSessionId);
  const streaming = useConversationStore((s) => s.streamingMap);
  const pendingSessionIds = useDecisionStore(
    useShallow((s) => {
      const all = s.current ? [s.current, ...s.queue] : s.queue;
      return all.map((d) => d.sessionId).filter(Boolean) as string[];
    }),
  );
  const decisions = new Set(pendingSessionIds);

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
    <div className={`flex flex-col shrink-0 border-r border-neutral-800/80 bg-neutral-950 h-full transition-[width] duration-200 ease-out ${collapsed ? 'w-10' : 'w-64'}`}>
      {collapsed ? (
        <div className="flex flex-col items-center py-2 gap-2">
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 transition-colors"
            onClick={() => setCollapsed(false)}
            title="展开侧边栏"
          >
            <span className="i-mdi:chevron-right text-base" aria-hidden />
          </button>
          <div className="flex flex-col items-center gap-1.5 mt-1">
            {sessions.recent.slice(0, 8).map((s) => {
              const dot = getStatusDot(s, streaming, decisions);
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
          <div className="px-1.5 py-2 border-b border-neutral-800/60">
            <SidebarCommand
              icon="i-mdi:square-edit-outline"
              label="新对话"
              onClick={async () => {
                const newId = await useSessionStore.getState().createSession();
                if (newId) void useConversationStore.getState().viewSession(newId);
              }}
            />
            <SidebarCommand
              icon="i-mdi:magnify"
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
              decisions={decisions}
            />
            <SidebarSection
              label="对话"
              sessions={conversationSessions}
              viewedId={viewedId}
              streaming={streaming}
              decisions={decisions}
              emptyText="暂无独立对话"
            />
            <SidebarSection
              label="归档"
              sessions={sessions.archived}
              viewedId={viewedId}
              streaming={streaming}
              decisions={decisions}
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

function SidebarCommand({
  icon, label, onClick,
}: {
  icon: string;
  label: string;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      className={`w-full ${sidebarBlockClass}`}
      onClick={onClick}
    >
      <span className={`${icon} text-base text-neutral-400`} aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

function ProjectListSection({
  label, groups, viewedId, streaming, decisions,
}: {
  label: string;
  groups: ProjectGroup[];
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  decisions: Set<string>;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const total = groups.reduce((sum, g) => sum + g.sessions.length, 0);
  const maxHeight = Math.min(900, total * 36 + groups.length * 34 + 12);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon="i-mdi:folder-multiple-outline"
        count={groups.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
        <div className="flex flex-col gap-1 px-1.5 pb-1">
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-xs text-neutral-700">暂无项目</p>
          ) : groups.map((g) => (
            <ProjectNode
              key={g.label}
              group={g}
              viewedId={viewedId}
              streaming={streaming}
              decisions={decisions}
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

function ProjectNode({
  group, viewedId, streaming, decisions,
}: {
  group: ProjectGroup;
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  decisions: Set<string>;
}): JSX.Element {
  const hasActive = group.sessions.some((s) => s.id === (viewedId as string));
  const [collapsed, setCollapsed] = useState(!hasActive);
  const maxHeight = Math.min(560, group.sessions.length * 38 + 6);

  useEffect(() => {
    if (hasActive) setCollapsed(false);
  }, [hasActive]);

  return (
    <div>
      <button
        className={`group/project w-full flex items-center gap-2 h-9 px-2 rounded-md text-sm transition-[background-color,color,box-shadow] duration-150 ease-out ${
          hasActive ? 'bg-neutral-800 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-neutral-300 hover:bg-neutral-900/90 hover:text-neutral-50'
        }`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`i-mdi:folder-outline text-base ${hasActive ? 'text-neutral-300' : 'text-neutral-400'}`} aria-hidden />
        <span className="flex-1 truncate text-left">{group.label}</span>
        <span className={`text-[11px] tabular-nums ${hasActive ? 'text-neutral-300' : 'text-neutral-500'}`}>{group.sessions.length}</span>
        <span className={`i-mdi:chevron-down text-xs ${hasActive ? 'text-neutral-300' : 'text-neutral-500'} transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
      </button>
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
        <div className="flex flex-col gap-0.5 pt-0.5">
          {group.sessions.map((s) => (
            <SidebarRow
              key={s.id}
              session={s}
              isActive={s.id === (viewedId as string)}
              streaming={streaming}
              decisions={decisions}
              nested
            />
          ))}
        </div>
      </AnimatedCollapse>
    </div>
  );
}

function SidebarSection({
  label, sessions, viewedId, streaming, decisions, collapsed: initCollapsed = false, emptyText,
}: {
  label: string;
  sessions: SessionWire[];
  viewedId: SessionId | null;
  streaming: Map<string, unknown>;
  decisions: Set<string>;
  collapsed?: boolean;
  emptyText?: string;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(initCollapsed);
  const maxHeight = Math.min(760, Math.max(1, sessions.length) * 38 + 8);

  return (
    <div className="mb-1">
      <SectionHeader
        label={label}
        icon={label === '归档' ? 'i-mdi:archive-outline' : 'i-mdi:message-outline'}
        count={sessions.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <AnimatedCollapse open={!collapsed} maxHeight={maxHeight}>
        <div className="flex flex-col gap-0.5 px-1.5 pb-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-neutral-700">{emptyText ?? '暂无内容'}</p>
          ) : sessions.map((s) => (
            <SidebarRow
              key={s.id}
              session={s}
              isActive={s.id === (viewedId as string)}
              streaming={streaming}
              decisions={decisions}
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
    <button
      className={`${sidebarBlockClass} mx-1.5 mb-0.5 w-[calc(100%-0.75rem)]`}
      onClick={onToggle}
    >
      <span className={`${icon} text-base text-neutral-400`} aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-neutral-500">{count}</span>
      <span className={`i-mdi:chevron-right text-xs text-neutral-500 transition-transform duration-200 ease-out ${collapsed ? '' : 'rotate-90'}`} aria-hidden />
    </button>
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
  decisions: Set<string>,
): StatusDot {
  if (streaming.has(session.id)) return { cls: 'bg-blue-400 animate-pulse' };
  if (decisions.has(session.id)) return { cls: 'bg-yellow-400 animate-pulse' };
  if (session.lastTurnStatus === 'failed' || session.lastTurnStatus === 'aborted') {
    return { cls: 'bg-red-400' };
  }
  if (session.hasUnread) return { cls: 'bg-green-400' };
  return null;
}

function SidebarRow({ session, isActive, streaming, decisions, nested = false }: {
  session:   SessionWire;
  isActive:  boolean;
  streaming: Map<string, unknown>;
  decisions: Set<string>;
  nested?:   boolean;
}): JSX.Element {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const dot = getStatusDot(session, streaming, decisions);
  const isRunning = streaming.has(session.id);
  const timeLabel = formatRelativeTime(session.lastActivityAt);

  const menuItems: MenuItem[] = [
    {
      kind:     'item',
      label:    session.pinned ? '取消固定' : '固定',
      icon:     session.pinned ? 'i-mdi:pin-off-outline' : 'i-mdi:pin-outline',
      onSelect: () => void useSessionStore.getState().pinSession(session.id as SessionId, !session.pinned),
    },
    {
      kind:     'item',
      label:    '重命名',
      icon:     'i-mdi:pencil-outline',
      onSelect: () => {
        const name = prompt('新名称', session.title);
        if (name) void useSessionStore.getState().renameSession(session.id as SessionId, name);
      },
    },
    {
      kind:     'item',
      label:    'Fork',
      icon:     'i-mdi:source-fork',
      onSelect: () => void (async () => {
        const newId = await useSessionStore.getState().forkSession(session.id as SessionId);
        void useConversationStore.getState().viewSession(newId);
      })(),
    },
    {
      kind:     'item',
      label:    '设置分组',
      icon:     'i-mdi:tag-outline',
      onSelect: () => {
        const label = prompt('分组名称（留空取消分组）', session.groupLabel ?? '');
        if (label !== null) void useSessionStore.getState().setSessionGroup(session.id as SessionId, label.trim() || null);
      },
    },
    {
      kind:     'item',
      label:    '工作区目录',
      icon:     'i-mdi:folder-outline',
      onSelect: () => setShowWorkspace(true),
    },
    {
      kind:     'item',
      label:    '归档',
      icon:     'i-mdi:archive-outline',
      onSelect: () => void useSessionStore.getState().archiveSession(session.id as SessionId),
    },
    { kind: 'separator' },
    {
      kind:     'item',
      label:    '删除',
      icon:     'i-mdi:delete-outline',
      danger:   true,
      onSelect: () => {
        if (confirm('确定删除这个会话？')) {
          void (async () => {
            await useSessionStore.getState().deleteSession(session.id as SessionId);
            useConversationStore.getState().evictSession(session.id as SessionId);
          })();
        }
      },
    },
  ];

  return (
    <div
      className={`group relative flex items-center gap-1.5 h-9 pr-2 rounded-md text-sm cursor-pointer transition-[background-color,color,box-shadow] duration-150 ease-out ${
        nested ? 'pl-6' : 'pl-2'
      } ${
        isActive
          ? 'bg-neutral-800 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
          : 'text-neutral-300 hover:bg-neutral-900/90 hover:text-neutral-50'
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
                className="w-0.5 h-0.5 rounded-full bg-neutral-500 animate-pulse"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full border ${isActive ? 'border-neutral-400' : 'border-neutral-700'}`} />
        )}
      </span>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {session.pinned && (
          <span className={`i-mdi:pin-outline text-[11px] shrink-0 ${isActive ? 'text-neutral-300' : 'text-neutral-500'}`} aria-hidden />
        )}
        <span className="truncate min-w-0 leading-snug">
          {session.title || '新对话'}
        </span>
      </div>

      <div className="shrink-0 relative w-12 flex justify-end" onClick={(e) => e.stopPropagation()}>
        <span className={`text-[11px] tabular-nums transition-opacity ${
          isActive ? 'opacity-0' : 'text-neutral-500 group-hover:opacity-0'
        }`}>
          {timeLabel}
        </span>
        <DropdownMenu
          trigger={
            <button className={`absolute right-0 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-neutral-500 hover:text-neutral-100 rounded hover:bg-neutral-700/80 transition-[opacity,color,background-color] ${
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}>
              <span className="i-mdi:dots-horizontal text-xs" aria-hidden />
            </button>
          }
          items={menuItems}
          side="right"
          align="start"
        />

        {showWorkspace && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setShowWorkspace(false)} />
            <WorkspaceEditor session={session} onClose={() => setShowWorkspace(false)} />
          </>
        )}
      </div>
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
        className="absolute left-1/2 top-14 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-neutral-700/80 bg-neutral-900/95 shadow-2xl overflow-hidden animate-scale-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-neutral-800/80">
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
            className="bg-neutral-800/80 border-neutral-700/60"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto p-1.5">
          <div className="px-2 py-1.5 text-xs text-neutral-500">
            {trimmed ? (loading ? '搜索中…' : '匹配结果') : '近期对话'}
          </div>

          {visibleResults.length === 0 && !loading ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-500">
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
    <button
      className="w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-neutral-800 transition-colors group"
      onClick={onSelect}
    >
      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
        item.matchKind === 'message' ? 'bg-neutral-500' : 'bg-neutral-400'
      }`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-neutral-100">
          {item.session.title || '新对话'}
        </span>
        <span className="block truncate text-xs text-neutral-500 mt-0.5">
          {snippet || (query ? '标题匹配' : formatRelativeTime(item.session.lastActivityAt))}
        </span>
      </span>
      <span className="shrink-0 max-w-28 truncate text-xs text-neutral-500 mt-0.5">
        {project}
      </span>
    </button>
  );
}

function WorkspaceEditor({ session, onClose }: { session: SessionWire; onClose(): void }): JSX.Element {
  const [paths, setPaths] = useState<string[]>(session.workspaceRoots ?? []);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  function addPath(): void {
    const p = input.trim();
    if (!p || paths.includes(p)) return;
    setPaths([...paths, p]);
    setInput('');
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await useSessionStore.getState().setWorkspaceRoots(session.id as SessionId, paths);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="absolute left-full top-0 ml-1 z-50 bg-neutral-800 border border-neutral-600 rounded-xl p-3 shadow-xl w-72"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs text-neutral-400 mb-2 font-medium">工作区目录</p>
      <div className="flex flex-col gap-1 mb-2 max-h-36 overflow-y-auto">
        {paths.length === 0 && <p className="text-xs text-neutral-500 py-1">暂无工作区</p>}
        {paths.map((p) => (
          <div key={p} className="flex items-center justify-between bg-neutral-900 rounded-lg px-2 py-1 gap-2">
            <span className="text-xs text-neutral-300 font-mono truncate flex-1" title={p}>{p}</span>
            <button
              className="text-neutral-500 hover:text-red-400 shrink-0"
              onClick={() => setPaths(paths.filter((x) => x !== p))}
            >
              <span className="i-mdi:close text-sm" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-1 mb-3">
        <Input
          inputSize="sm"
          className="font-mono"
          placeholder="D:\\path\\to\\project"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
        />
        <button
          className="px-2 rounded-md bg-neutral-700 text-neutral-300 text-xs hover:bg-neutral-600"
          onClick={addPath}
        >+</button>
      </div>
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-lg bg-primary-500/20 text-primary-200 text-xs hover:bg-primary-500/30 transition-colors disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >{saving ? '保存中…' : '保存'}</button>
        <button
          className="px-3 py-1.5 rounded-lg text-neutral-400 text-xs hover:text-neutral-200"
          onClick={onClose}
        >取消</button>
      </div>
    </div>
  );
}

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
    const root = s.workspaceRoots?.[0];
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
    ?? (session.workspaceRoots?.[0] ? basename(session.workspaceRoots[0]!) : '对话');
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
