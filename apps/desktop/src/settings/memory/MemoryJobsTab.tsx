import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import { Badge, Button, Callout, Card, Skeleton, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryJob } from '../../api/memory.js';
import {
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  JOB_STATUS_VARIANT,
  relativeTime,
} from './memoryLabels.js';
import { PageHeader } from '../shared/PageHeader.js';

const JOB_REFRESH_INTERVAL_MS = 5_000;

type JobTrack = 'work' | 'relationship';

export function MemoryJobsTab(): JSX.Element {
  const [jobs, setJobs] = useState<readonly MemoryJob[] | null>(null);
  const [history, setHistory] = useState<readonly MemoryJob[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const failedListId = useId();
  const historyListId = useId();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);

    try {
      const result = await memoryApi.listJobs();
      setJobs(result.items);
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, '读取 Memory 后台任务失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const timer = setInterval(
      () => void refresh(),
      JOB_REFRESH_INTERVAL_MS,
    );

    return () => clearInterval(timer);
  }, [refresh]);

  async function toggleHistory(): Promise<void> {
    if (showHistory) {
      setShowHistory(false);
      return;
    }

    setShowHistory(true);

    try {
      const result = await memoryApi.listJobHistory();
      setHistory(result.items);
      setError(null);
    } catch (reason) {
      setHistory([]);
      setError(errorMessage(reason, '读取 Memory 任务历史失败'));
    }
  }

  const active = (jobs ?? []).filter(
    job => job.status === 'pending' || job.status === 'running',
  );

  const failed = (jobs ?? []).filter(job => job.status === 'failed');

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <PageHeader
        title="自动任务"
        description="提取、整合与维护由后端按固定时机自动运行"
        action={(
          <>
            <Button
              variant="ghost"
              size="sm"
              icon="i-lucide:refresh-cw"
              loading={loading}
              onClick={() => void refresh()}
            >
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void toggleHistory()}
              aria-expanded={showHistory}
              aria-controls={historyListId}
            >
              {showHistory ? '收起历史记录' : '查看历史记录'}
            </Button>
          </>
        )}
      />

      {error && <Callout variant="danger">{error}</Callout>}

      {!jobs && loading && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 rounded-xl" />)}
        </div>
      )}

      {failed.length > 0 && (
        <Callout variant="danger" className="shrink-0 ema-pop-in-spring">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left font-semibold"
            aria-expanded={showFailed}
            aria-controls={failedListId}
            onClick={() => setShowFailed(value => !value)}
          >
            <span>有 {failed.length} 个任务需要注意</span>
            <span className="flex shrink-0 items-center gap-1 text-xs">
              {showFailed ? '收起任务' : '展开任务'}
              <span className={`i-lucide:chevron-down transition-transform ${showFailed ? 'rotate-180' : ''}`} aria-hidden />
            </span>
          </button>
          <div
            id={failedListId}
            className={`ema-collapsible ${showFailed ? '' : 'invisible'}`}
            style={{ gridTemplateRows: showFailed ? '1fr' : '0fr', opacity: showFailed ? 1 : 0 }}
            aria-hidden={!showFailed}
          >
            <div>
              <div className="mt-2 flex flex-col gap-2">
                {failed.map((job, i) => (
                  <JobRow key={job.id} job={job} index={i} />
                ))}
              </div>
            </div>
          </div>
        </Callout>
      )}

      <section>
        <h4 className="mb-2 text-xs font-semibold text-[var(--ema-text-secondary)]">
          正在处理
        </h4>

        {active.length === 0 ? (
          <Card
            variant="glass"
            padding="md"
            className="ema-card-decorate ema-card-decorate--cross ema-pop-in-spring"
          >
            <p className="text-center text-xs text-[var(--ema-text-tertiary)]">
              当前没有排队或运行中的任务。
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((job, i) => (
              <JobRow key={job.id} job={job} index={i} />
            ))}
          </div>
        )}
      </section>

      <div
        id={historyListId}
        className={`ema-collapsible shrink-0 ${showHistory ? '' : 'invisible'}`}
        style={{ gridTemplateRows: showHistory ? '1fr' : '0fr', opacity: showHistory ? 1 : 0 }}
        aria-hidden={!showHistory}
      >
        <div>
          <section>
            <h4 className="mb-2 text-xs font-semibold text-[var(--ema-text-secondary)]">
              最近 100 条终态记录
            </h4>

            {history === null ? (
              <div className="flex justify-center py-8">
                <Spinner size="sm" />
              </div>
            ) : history.length === 0 ? (
              <p className="text-xs text-[var(--ema-text-tertiary)]">
                还没有已完成或失败的任务。
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {history.map((job, i) => (
                  <JobRow key={job.id} job={job} index={i} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function JobRow({ job, index = 0 }: { job: MemoryJob; index?: number }): JSX.Element {
  const track = resolveJobTrack(job);

  return (
    <Card
      variant="glass"
      padding="sm"
      className="shrink-0 ema-card-decorate ema-card-decorate--cross ema-pop-in-spring"
      style={{ '--stagger-i': index } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {track && <TrackBadge track={track} />}

        <Badge
          variant={JOB_STATUS_VARIANT[job.status]}
          dot={job.status === 'running'}
        >
          {JOB_STATUS_LABEL[job.status]}
        </Badge>

        <span className="font-semibold text-[var(--ema-text-secondary)]">
          {JOB_KIND_LABEL[job.kind]}
        </span>

        <span className="ml-auto text-[var(--ema-text-tertiary)]">
          {relativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt)}
        </span>
      </div>

      {job.error && (
        <details className="group/error mt-2 text-xs text-[var(--ema-danger-text)]">
          <summary className="flex cursor-pointer list-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden">
            <span className="i-lucide:chevron-right transition-transform group-open/error:rotate-90" aria-hidden />
            错误详情
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{job.error}</p>
        </details>
      )}
    </Card>
  );
}

function TrackBadge({ track }: { track: JobTrack }): JSX.Element {
  // 语义 token 双主题自适应;硬编码 sky/violet 浅色系在暗色下会瞎。
  const tones = track === 'work'
    ? 'border-[var(--ema-info)]/30 bg-[var(--ema-info-muted)] text-[var(--ema-info-text)]'
    : 'border-[var(--ema-violet)]/30 bg-[var(--ema-violet-muted)] text-[var(--ema-violet-text)]';
  return (
    <span className={`inline-flex h-5 items-center rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide ${tones}`}>
      {track === 'work' ? 'Work' : 'Relationship'}
    </span>
  );
}

/**
 * 优先读取后端未来可能直接返回的 track 字段。
 * 当前若 MemoryJob 没有 track，则从 kind 名称兜底推断。
 * 这样前端不用为了展示 Work / Relationship 改现有 Job API。
 */
function resolveJobTrack(job: MemoryJob): JobTrack | null {
  const possibleTrack = (job as MemoryJob & { track?: unknown }).track;

  if (possibleTrack === 'work' || possibleTrack === 'relationship') {
    return possibleTrack;
  }

  const kind = String(job.kind).toLowerCase();

  if (kind.includes('relationship')) return 'relationship';
  if (kind.includes('work')) return 'work';

  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
