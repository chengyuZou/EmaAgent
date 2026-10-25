import type { JSX } from 'react';
import { Tooltip, Badge } from '@ema-agent/ui';
import type { WebSearchResult } from './WebSearchTool.js';
import type { SearchProgress } from './adapters/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asWebSearchResult(data: unknown): WebSearchResult | null {
  if (!isRecord(data) || typeof data['query'] !== 'string' || !Array.isArray(data['results'])) {
    return null;
  }
  if (!data['results'].every(
    (entry) => isRecord(entry)
      && typeof entry['title'] === 'string'
      && typeof entry['url'] === 'string',
  )) {
    return null;
  }
  return data as unknown as WebSearchResult;
}

export function webSearchResultCopyText(data: unknown): string | null {
  const result = asWebSearchResult(data);
  if (!result) return null;
  return result.results.map((entry) => [entry.title, entry.url, entry.snippet].filter(Boolean).join('\n')).join('\n\n');
}

function asSearchProgress(progress: unknown): SearchProgress | null {
  if (!isRecord(progress)) return null;
  if (progress['type'] === 'query_update' && typeof progress['query'] === 'string') {
    return progress as unknown as SearchProgress;
  }
  if (
    progress['type'] === 'search_results_received'
    && typeof progress['query'] === 'string'
    && typeof progress['resultCount'] === 'number'
  ) {
    return progress as unknown as SearchProgress;
  }
  return null;
}

/** 行头摘要:查询词. */
export function webSearchTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['query'] === 'string' ? args['query'] : null;
}

/** 进度行:取最近一条有效进度事件,展示当前阶段. */
export function WebSearchProgressView({ progress }: { progress: readonly unknown[] }): JSX.Element | null {
  const latest = [...progress].reverse().map(asSearchProgress).find((entry) => entry !== null);
  if (!latest) return null;
  return (
    <span className="text-[11px] text-[var(--ema-text-tertiary)]">
      {latest.type === 'query_update'
        ? `正在搜索"${latest.query}"...`
        : `已收到 ${latest.resultCount} 条结果,正在整理...`}
    </span>
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function WebSearchArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['query'] !== 'string') return null;
  const allowed = stringList(args['allowed_domains']);
  const blocked = stringList(args['blocked_domains']);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed">
      <span className="min-w-0 text-[var(--ema-text-secondary)]">{args['query']}</span>
      {allowed.length > 0 && (
        <Badge variant="primary">限 {allowed.length} 个域名</Badge>
      )}
      {blocked.length > 0 && (
        <Badge variant="warn">排除 {blocked.length} 个域名</Badge>
      )}
    </div>
  );
}

export function WebSearchResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asWebSearchResult(data);
  if (!result) return null;
  if (result.results.length === 0) {
    return (
      <div className="ema-tool-result-details text-[11px] text-[var(--ema-text-tertiary)]">
        未找到搜索结果
      </div>
    );
  }
  return (
    <div className="ema-tool-text-scroll">
      <div className="ema-tool-result-details flex w-max min-w-full flex-col gap-1.5 text-[11px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="text-[var(--ema-text-secondary)]">
            找到 <span className="font-medium text-[var(--ema-text-primary)]">
              {result.results.length.toLocaleString()}
            </span> 条结果
          </span>
          <span className="text-[var(--ema-text-tertiary)]">
            "{result.query}"
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {result.results.map((entry) => (
            <li key={entry.url} className="flex min-w-0 items-baseline gap-2">
              <Tooltip content={entry.url} variant="card">
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-[var(--ema-primary)] transition-colors hover:text-[var(--ema-primary-hover)] hover:underline"
                >
                  {entry.title || entry.url}
                </a>
              </Tooltip>
              {entry.snippet && (
                <span className="text-[var(--ema-text-tertiary)]">
                  {entry.snippet}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
