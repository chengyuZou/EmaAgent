// 侧栏会话搜索覆盖层:防抖调用搜索接口,本地模糊重排,Enter 直达首条。
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Button, Input } from '@ema-agent/ui';
import { sessionsApi, type SessionWire, type SessionSearchItem } from '../../api/sessions.js';
import { useConversationStore } from '../../stores/conversation-store.js';

import { rankSearchResults, toRecentSearchItem } from './sidebarSearch.js';
import { formatRelativeTime, projectLabelFor } from './sidebarFormat.js';

export function SessionSearchOverlay({
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
    void useConversationStore.getState().viewSession(id);
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
