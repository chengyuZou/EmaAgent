import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Callout, Input, Select, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryJobCursor } from '../../api/memory.js';
import { useWindowSuspension } from '../../hooks/use-window-suspension.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { PageHeader } from '../shared/PageHeader.js';
import { MemoryJobRow } from './memoryJobRow.js';
import {
  MEMORY_TIME_RANGE_LABEL,
  MEMORY_TIME_RANGES,
  memoryTimeRange,
  type MemoryTimeRange,
} from './memoryLabels.js';
import { useMemoryQuery } from './useMemoryQuery.js';

const JOB_REFRESH_INTERVAL_MS = 5_000;

export function MemoryJobsTab(): JSX.Element {
  const view = useMainNavigationStore(state => state.activeView);
  const tab = useMainNavigationStore(state => state.settingsTab);
  const suspended = useWindowSuspension();
  const active = view === MainView.Settings && tab === 'memory-jobs' && !suspended;
  const [range, setRange] = useState<MemoryTimeRange>('today');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [position, setPosition] = useState<{ page: number; cursor?: MemoryJobCursor }>({ page: 1 });
  const [pageInput, setPageInput] = useState('1');
  const [ignoringAll, setIgnoringAll] = useState(false);
  const [ignoreError, setIgnoreError] = useState<string | null>(null);
  const [jumpError, setJumpError] = useState<string | null>(null);

  const readPage = useMemo(() => {
    let cursor = position.cursor;
    return (signal: AbortSignal) => {
      const navigationCursor = cursor;
      cursor = undefined;
      // 游标只用于本次翻页. 定时刷新按页码重新定位, 新任务出现后不会一直停在旧页边界.
      return memoryApi.listJobs({
        ...memoryTimeRange(range),
        order,
        page: position.page,
        ...(navigationCursor ? { cursor: navigationCursor } : {}),
      }, signal);
    };
  }, [range, order, position]);
  const query = useMemoryQuery(active, JOB_REFRESH_INTERVAL_MS, readPage);
  const result = query.value;
  const page = result?.page ?? 1;
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / (result?.pageSize ?? 1)));
  const pageNumbers = useMemo(() => visiblePageNumbers(page, pageCount), [page, pageCount]);
  const firstItem = result && result.items.length > 0 ? (page - 1) * result.pageSize + 1 : 0;
  const lastItem = result && result.items.length > 0 ? firstItem + result.items.length - 1 : 0;

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const goToPage = useCallback((target: number, cursor?: MemoryJobCursor): void => {
    setJumpError(null);
    setPosition({ page: target, ...(cursor ? { cursor } : {}) });
    setPageInput(String(target));
  }, []);

  function changeRange(value: string): void {
    setRange(value as MemoryTimeRange);
    goToPage(1);
  }

  function changeOrder(): void {
    setOrder(current => current === 'desc' ? 'asc' : 'desc');
    goToPage(1);
  }

  function jump(): void {
    const target = Number(pageInput);
    if (!Number.isInteger(target) || target < 1 || target > pageCount) {
      setJumpError(`请输入 1 到 ${pageCount} 之间的页码.`);
      return;
    }
    goToPage(target);
  }

  async function ignoreAll(): Promise<void> {
    setIgnoringAll(true);
    setIgnoreError(null);
    try {
      await memoryApi.ignoreAllJobs();
      query.refresh();
    } catch (reason) {
      setIgnoreError(reason instanceof Error ? reason.message : '忽略全部提醒失败');
    } finally {
      setIgnoringAll(false);
    }
  }

  return (
    <div className="ema-memory-jobs">
      <PageHeader
        title="后台任务"
        description="查看提取、整合与维护结果. 忽略提醒不会删除记录或重试任务."
      />

      <div className="ema-memory-jobs-toolbar">
        {(result?.unignoredFailureCount ?? 0) > 0 && (
          <Button
            variant="ghost"
            size="sm"
            icon="i-lucide:bell-off"
            loading={ignoringAll}
            onClick={() => void ignoreAll()}
          >
            忽略全部提醒
          </Button>
        )}

        <div className="ema-memory-jobs-filters">
          <Select
            aria-label="任务时间范围"
            value={range}
            options={MEMORY_TIME_RANGES}
            onChange={changeRange}
            className="ema-memory-range-select"
            trigger={(
              <span className="ema-memory-range-label">
                <span>时间范围</span>
                <strong>{MEMORY_TIME_RANGE_LABEL[range]}</strong>
              </span>
            )}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={order === 'desc' ? 'i-lucide:list-filter' : 'i-lucide:list-ordered'}
            onClick={changeOrder}
            aria-label="切换任务排列顺序"
          >
            {order === 'desc' ? '最新在前' : '最早在前'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="i-lucide:refresh-cw"
            loading={query.loading}
            onClick={query.refresh}
            aria-label="刷新任务"
          />
        </div>
      </div>

      {query.error && (
        <Callout variant="danger">{query.error}</Callout>
      )}
      {ignoreError && (
        <Callout variant="danger">{ignoreError}</Callout>
      )}

      {result && result.unignoredFailureCount > 0 && (
        <p className="ema-memory-reminder-count" role="status">
          <span className="i-lucide:circle-alert" aria-hidden />
          共有 {result.unignoredFailureCount} 条失败提醒未忽略, 不受时间筛选限制.
        </p>
      )}

      <section
        className="ema-memory-job-list"
        aria-label="处理记录"
        aria-busy={query.loading}
      >
        {!result && query.loading && (
          <div className="ema-memory-section-loading">
            <Spinner size="sm" />
          </div>
        )}
        {result?.items.length === 0 && (
          <p className="ema-memory-empty">这个时间范围内没有处理记录.</p>
        )}
        {result?.items.map(job => (
          <MemoryJobRow
            key={job.id}
            job={job}
            active={active}
            onIgnored={query.refresh}
          />
        ))}
      </section>

      {result && result.total > 0 && (
        <footer className="ema-memory-pagination">
          <p>第 {firstItem}-{lastItem} 条, 共 {result.total} 条. 每页 {result.pageSize} 条.</p>

          <nav className="ema-memory-page-buttons" aria-label="处理记录分页">
            <Button
              variant="secondary"
              size="sm"
              shape="rounded"
              icon="i-lucide:chevron-left"
              aria-label="上一页"
              disabled={!result.previousCursor || query.loading}
              onClick={() => goToPage(page - 1, result.previousCursor ?? undefined)}
            />
            {pageNumbers.map(number => (
              <Button
                key={number}
                variant="secondary"
                size="sm"
                shape="rounded"
                aria-label={`第 ${number} 页`}
                aria-current={number === page ? 'page' : undefined}
                disabled={query.loading}
                onClick={() => goToPage(number)}
              >
                {number}
              </Button>
            ))}
            <Button
              variant="secondary"
              size="sm"
              shape="rounded"
              icon="i-lucide:chevron-right"
              aria-label="下一页"
              disabled={!result.nextCursor || query.loading}
              onClick={() => goToPage(page + 1, result.nextCursor ?? undefined)}
            />
          </nav>

          <div className="ema-memory-page-jump">
            <label htmlFor="memory-job-page">跳至</label>
            <Input
              id="memory-job-page"
              type="number"
              inputSize="sm"
              min={1}
              max={pageCount}
              value={pageInput}
              error={jumpError !== null}
              aria-describedby={jumpError ? 'memory-job-page-error' : undefined}
              onChange={event => {
                setPageInput(event.target.value);
                setJumpError(null);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  jump();
                }
              }}
            />
            <span>页 / 共 {pageCount} 页</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={query.loading}
              onClick={jump}
            >
              跳转
            </Button>
          </div>
          {jumpError && (
            <p id="memory-job-page-error" className="ema-memory-inline-error" role="alert">
              {jumpError}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}

function visiblePageNumbers(current: number, total: number): number[] {
  const visiblePageLimit = 10;
  const visibleCount = Math.min(visiblePageLimit, total);
  const pagesBeforeCurrent = Math.floor(visibleCount / 2);

  // 靠近首尾时移动整段页码, 保持显示数量, 不生成范围之外的页码.
  const latestStart = total - visibleCount + 1;
  const firstPage = Math.max(
    1,
    Math.min(current - pagesBeforeCurrent, latestStart),
  );

  return Array.from(
    { length: visibleCount },
    (_, index) => firstPage + index,
  );
}
