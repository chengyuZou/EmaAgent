// WebSearchTool 的桌面展示: 参数行(query + 域名过滤)、结果摘要(条数)与两态进度。
// 只消费本 Tool 的类型化 data; 类型守卫失败返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
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

/** 行头摘要：查询词。 */
export function webSearchTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['query'] === 'string' ? args['query'] : null;
}

/** 进度行：取最近一条有效进度事件，展示当前阶段。 */
export function WebSearchProgressView({ progress }: { progress: readonly unknown[] }): JSX.Element | null {
  const latest = [...progress].reverse().map(asSearchProgress).find((entry) => entry !== null);
  if (!latest) return null;
  return (
    <span className="text-[11px] text-[var(--ema-text-tertiary)]">
      {latest.type === 'query_update'
        ? `正在搜索“${latest.query}”…`
        : `已收到 ${latest.resultCount} 条结果，正在整理…`}
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
      <span className="break-all text-[var(--ema-text-secondary)]">{args['query']}</span>
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
      <span className="text-[11px] text-[var(--ema-text-tertiary)]">
        未找到搜索结果
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-[11px] leading-relaxed">
      <div className="flex items-center gap-2">
        <span className="text-[var(--ema-text-secondary)]">
          找到 <span className="font-medium text-[var(--ema-text-primary)]">
            {result.results.length.toLocaleString()}
          </span> 条结果
        </span>
        <span className="truncate text-[var(--ema-text-tertiary)]">
          “{result.query}”
        </span>
      </div>
      <ul className="flex max-h-40 flex-col gap-1 overflow-auto pr-1">
        {result.results.map((entry) => (
          <li key={entry.url} className="flex min-w-0 items-baseline gap-2">
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              title={entry.url}
              className="max-w-[65%] shrink-0 truncate text-[var(--ema-primary)] transition-colors hover:text-[var(--ema-primary-hover)] hover:underline"
            >
              {entry.title || entry.url}
            </a>
            {entry.snippet && (
              <span className="truncate text-[var(--ema-text-tertiary)]">
                {entry.snippet}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
