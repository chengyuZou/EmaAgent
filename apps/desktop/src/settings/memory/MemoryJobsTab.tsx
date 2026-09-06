import { useCallback, useEffect, useState, type JSX } from 'react';
import { Badge, Button, Callout, Card, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryJob } from '../../api/memory.js';
import {
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  JOB_STATUS_VARIANT,
  relativeTime,
} from './memoryLabels.js';

const JOB_REFRESH_INTERVAL_MS = 5_000;

export function MemoryJobsTab(): JSX.Element {
  const [jobs, setJobs] = useState<readonly MemoryJob[] | null>(null);
  const [history, setHistory] = useState<readonly MemoryJob[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
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
    const timer = setInterval(() => void refresh(), JOB_REFRESH_INTERVAL_MS);
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

  const active = (jobs ?? []).filter(job => job.status === 'pending' || job.status === 'running');
  const failed = (jobs ?? []).filter(job => job.status === 'failed');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">自动任务</h3>
          <p className="mt-0.5 text-xs text-[var(--ema-text-tertiary)]">
            提取、整合与维护由后端按固定时机自动运行。
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="i-lucide:refresh-cw"
          className="ml-auto"
          loading={loading}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void toggleHistory()}>
          {showHistory ? '收起历史记录' : '查看历史记录'}
        </Button>
      </div>

      {error && <Callout variant="danger">{error}</Callout>}
      {!jobs && loading && <div className="flex justify-center py-12"><Spinner size="md" /></div>}

      {failed.length > 0 && (
        <Callout variant="danger">
          <p className="font-semibold">有 {failed.length} 个任务需要注意</p>
          <div className="mt-2 flex flex-col gap-2">
            {failed.map(job => <JobRow key={job.id} job={job} />)}
          </div>
        </Callout>
      )}

      <section>
        <h4 className="mb-2 text-xs font-semibold text-[var(--ema-text-secondary)]">正在处理</h4>
        {active.length === 0 ? (
          <Card variant="glass" padding="md" className="ema-card-decorate ema-card-decorate--circuit">
            <p className="text-center text-xs text-[var(--ema-text-tertiary)]">当前没有排队或运行中的任务。</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map(job => <JobRow key={job.id} job={job} />)}
          </div>
        )}
      </section>

      {showHistory && (
        <section className="ema-slide-down">
          <h4 className="mb-2 text-xs font-semibold text-[var(--ema-text-secondary)]">最近 100 条终态记录</h4>
          {history === null ? (
            <div className="flex justify-center py-8"><Spinner size="sm" /></div>
          ) : history.length === 0 ? (
            <p className="text-xs text-[var(--ema-text-tertiary)]">还没有已完成或失败的任务。</p>
          ) : (
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
              {history.map(job => <JobRow key={job.id} job={job} />)}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function JobRow({ job }: { job: MemoryJob }): JSX.Element {
  return (
    <Card
      variant="glass"
      padding="sm"
      className="ema-card-decorate ema-card-decorate--circuit ema-stagger-in transition-all hover:border-[var(--ema-primary)] hover:shadow-[var(--ema-shadow-soft)]"
    >
      <div className="flex items-center gap-2 text-xs">
        <Badge variant={JOB_STATUS_VARIANT[job.status]} dot={job.status === 'running'}>
          {JOB_STATUS_LABEL[job.status]}
        </Badge>
        <span className="font-semibold text-[var(--ema-text-secondary)]">{JOB_KIND_LABEL[job.kind]}</span>
        <span className="text-[var(--ema-text-tertiary)]">{relativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt)}</span>
      </div>
      {job.error && <p className="mt-2 break-words text-xs text-[var(--ema-danger-text)]">{job.error}</p>}
    </Card>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
