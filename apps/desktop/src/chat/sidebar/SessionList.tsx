// 渲染普通/归档 Session 分区, 并提供只在用户搜索时请求的会话搜索层.
import {
  useCallback,
  useEffect,
  useState,
  type JSX,
} from 'react';
import { Dialog, IconButton, Input } from '@ema-agent/ui';
import {
  sessionsApi,
  type SessionListItem,
  type SessionSearchResult,
} from '../../api/sessions.js';
import type { SessionActivity } from '../../stores/sessionActivity.js';
import { useSessionStore } from '../../stores/session.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { Collapse, SectionButton } from './ProjectSection.js';
import type { SessionSidebarMoveInput } from '../../api/workspaces.js';
import { useSidebarDrag } from './SidebarDragContext.js';
import {
  SessionRow,
  formatRelativeTime,
} from './SessionRow.js';

interface SessionListProps {
  label: string;
  sessions: SessionListItem[];
  viewedId: string | null;
  activityBySession: ReadonlyMap<string, SessionActivity>;
  initiallyCollapsed?: boolean;
  emptyText?: string;
  dropDestination?: SessionSidebarMoveInput['destination'];
}

export function SessionList({
  label,
  sessions,
  viewedId,
  activityBySession,
  initiallyCollapsed = false,
  emptyText = '暂无内容',
  dropDestination,
}: SessionListProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const drag = useSidebarDrag();
  const endDropProps = dropDestination
    ? drag.sessionTargetProps(`sessions-end:${label}`, dropDestination, null)
    : {};

  return (
    <section className="mb-2">
      <SectionButton
        label={label}
        collapsed={collapsed}
        onClick={() => setCollapsed((value) => !value)}
      />

      <Collapse open={!collapsed}>
        <div className="flex flex-col gap-0.5 px-1.5 pb-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[var(--ema-text-tertiary)]">
              {emptyText}
            </p>
          ) : (
            sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                isActive={session.id === viewedId}
                activityBySession={activityBySession}
                dropDestination={dropDestination}
              />
            ))
          )}
          {dropDestination && (
            <div
              className={`ema-sidebar-drop-zone ema-drop-end ${drag.dragged?.kind === 'session' ? 'ema-drop-ready' : ''}`}
              {...endDropProps}
            />
          )}
        </div>
      </Collapse>
    </section>
  );
}

type SearchItem = SessionSearchResult['results'][number];

export function SessionSearch({
  recentSessions,
  onClose,
}: {
  recentSessions: SessionListItem[];
  onClose(): void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchItem[]>([]);
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
    const timer = window.setTimeout(() => {
      void sessionsApi.search({ q: trimmed, limit: 16 })
        .then((result) => {
          if (!cancelled) setResults(rankResults(trimmed, result.results));
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
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const visibleRecents = trimmed ? [] : recentSessions.slice(0, 10);
  const first = trimmed ? results[0] : undefined;
  const firstId = first?.session.id ?? visibleRecents[0]?.id;

  const select = useCallback((id: string, anchor?: string | null) => {
    useChatNavigationStore.getState().viewSession(id);
    if (anchor) void useSessionHistoryStore.getState().openAround(id, anchor);
    onClose();
  }, [onClose]);

  const visibleItems = trimmed
    ? results
    : visibleRecents.map((session) => ({
      session,
      anchorMessageId: null,
      snippet: '',
      matchKind: 'title' as const,
    }));

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      ariaLabel="搜索对话"
      hideClose
      widthClass="max-w-xl"
      className="ema-session-search"
    >
      <div className="ema-session-search-header">
        <span className="i-lucide:search shrink-0 text-base text-[var(--ema-text-tertiary)]" aria-hidden />
        <Input
          autoFocus
          mono={false}
          placeholder="搜索对话"
          aria-label="搜索对话"
          className="ema-session-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'Enter' && firstId) {
              select(firstId, first?.anchorMessageId);
            }
          }}
        />
        <IconButton label="关闭搜索" icon="i-lucide:x" variant="ghost" size="sm" shape="rounded" onClick={onClose} />
      </div>

      <div className="ema-session-search-results">
        <div className="ema-session-search-heading">
          {trimmed ? (loading ? '搜索中…' : '匹配结果') : '近期对话'}
        </div>

        {trimmed && results.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-sm text-[var(--ema-text-tertiary)]">
            没有匹配的对话
          </div>
        )}

        {visibleItems.map((item) => (
          <SearchRow
            key={`${item.session.id}:${item.anchorMessageId ?? 'title'}`}
            session={item.session}
            snippet={item.snippet}
            onSelect={() => select(item.session.id, item.anchorMessageId)}
          />
        ))}
      </div>
    </Dialog>
  );
}

function SearchRow({
  session,
  snippet,
  onSelect,
}: {
  session: SessionListItem;
  snippet?: string;
  onSelect(): void;
}): JSX.Element {
  const projectName = useSessionStore((state) => {
    if (!session.projectId) return null;
    const project = [...state.sessions.pinnedProjects, ...state.sessions.projects]
      .find((item) => item.id === session.projectId);
    return project?.name ?? null;
  });

  const showSnippet = Boolean(snippet && snippet !== session.title);
  return (
    <button
      type="button"
      className="ema-session-search-row focus-ring"
      data-has-snippet={showSnippet}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{session.title || '新对话'}</span>
        {showSnippet && (
          <span className="ema-session-search-snippet block truncate">{snippet}</span>
        )}
      </span>
      <span className="ema-session-search-meta">
        <span className="max-w-28 truncate">{projectName ?? '对话'}</span>
        <span className="tabular-nums">{formatRelativeTime(session.lastActivityAt)}</span>
      </span>
    </button>
  );
}

function rankResults(query: string, results: SearchItem[]): SearchItem[] {
  const normalized = query.toLowerCase().replace(/\s+/g, '');
  return [...results].sort((left, right) => (
    score(normalized, right) - score(normalized, left)
      || right.session.lastActivityAt - left.session.lastActivityAt
  ));
}

function score(query: string, item: SearchItem): number {
  const title = item.session.title.toLowerCase().replace(/\s+/g, '');
  const snippet = item.snippet.toLowerCase().replace(/\s+/g, '');
  const titleScore = title === query ? 4 : title.includes(query) ? 3 : 0;
  const snippetScore = snippet.includes(query) ? 2 : 0;
  return titleScore + snippetScore + (item.session.pinned ? 1 : 0);
}
