// 渲染普通/归档 Session 分区, 并提供只在用户搜索时请求的会话搜索层.
import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Button, Input } from '@ema-agent/ui';
import {
  sessionsApi,
  type SessionListItem,
  type SessionSearchResult,
} from '../../api/sessions.js';
import type { AgentSessionState } from '../../stores/agent.js';
import { useChatWorkspace } from '../state/chatWorkspace.js';
import { useHistoryStore } from '../state/history.js';
import { Collapse, SectionButton } from './ProjectSection.js';
import {
  SessionRow,
  formatRelativeTime,
  projectLabelFor,
} from './SessionRow.js';

interface SessionListProps {
  label: string;
  sessions: SessionListItem[];
  viewedId: string | null;
  agentSessions: ReadonlyMap<string, AgentSessionState>;
  initiallyCollapsed?: boolean;
  emptyText?: string;
}

export function SessionList({
  label,
  sessions,
  viewedId,
  agentSessions,
  initiallyCollapsed = false,
  emptyText = '暂无内容',
}: SessionListProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);

  return (
    <section className="mb-1">
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
                agentSessions={agentSessions}
              />
            ))
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
    void useChatWorkspace.getState().viewSession(id).then(() => {
      if (anchor) void useHistoryStore.getState().openAround(id, anchor);
    });
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
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className="absolute left-1/2 top-14 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-4)] shadow-[var(--ema-shadow-3)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--ema-border)] p-3">
          <Input
            autoFocus
            inputSize="md"
            placeholder="搜索对话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              if (event.key === 'Enter' && firstId) {
                select(firstId, first?.anchorMessageId);
              }
            }}
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto p-1.5">
          <div className="px-2 py-1.5 text-xs text-[var(--ema-text-tertiary)]">
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
      </div>
    </div>
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
  return row(onSelect, (
    <>
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--ema-text-tertiary)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{session.title || '新对话'}</span>
        <span className="mt-0.5 block truncate text-xs text-[var(--ema-text-tertiary)]">
          {snippet && snippet !== session.title
            ? snippet
            : formatRelativeTime(session.lastActivityAt)}
        </span>
      </span>
      <span className="max-w-28 shrink-0 truncate text-xs text-[var(--ema-text-tertiary)]">
        {projectLabelFor(session)}
      </span>
    </>
  ));
}

function row(onClick: () => void, children: ReactNode): JSX.Element {
  return (
    <Button
      variant="ghost"
      className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left font-normal hover:bg-[var(--ema-surface-2)]"
      onClick={onClick}
    >
      {children}
    </Button>
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
