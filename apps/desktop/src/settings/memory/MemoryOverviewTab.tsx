// 记忆概览:存储占用水位卡、进行中与失败的后台任务,以及维护/存储设置入口。
import { useEffect, type JSX } from 'react';
import {
  Badge, Button, Callout, Card, Divider, Progress, Spinner,
} from '@ema-agent/ui';
import { useMemoryStore } from '../../stores/memory-store.js';
import { showToast } from '../../lib/toast.js';
import { MemoryMaintenanceSettings } from './MemoryMaintenanceSettings.js';
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, relativeTime } from './memoryLabels.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const LEVEL_LABEL = {
  normal:        '正常',
  warning:       '接近上限',
  limitExceeded: '已超限',
} as const;

export function OverviewTab(): JSX.Element {
  const stats        = useMemoryStore((s) => s.stats);
  const statsLoading = useMemoryStore((s) => s.statsLoading);
  const statsError   = useMemoryStore((s) => s.statsError);
  const jobs         = useMemoryStore((s) => s.jobs);

  useEffect(() => {
    void useMemoryStore.getState().refreshStats();
    void useMemoryStore.getState().refreshJobs();
  }, []);

  const activeJobs = (jobs ?? []).filter((j) => j.status === 'pending' || j.status === 'running');
  const failedJobs = (jobs ?? []).filter((j) => j.status === 'failed');

  if (statsLoading && !stats) {
    return <div className="flex justify-center py-16"><Spinner size="md" /></div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {statsError && (
        <Callout variant="danger">
          记忆统计刷新失败：{statsError}
        </Callout>
      )}

      {/* Storage usage */}
      {stats && (
        <Card variant="elevated" padding="sm" className="ema-card-decorate ema-card-decorate--starfield">
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-semibold text-[var(--ema-text-tertiary)]">记忆存储</p>
            <Badge
              variant={stats.status.level === 'normal' ? 'success' : stats.status.level === 'warning' ? 'warn' : 'danger'}
              dot={stats.status.level !== 'normal'}
            >
              {LEVEL_LABEL[stats.status.level]}
            </Badge>
          </div>
          <Progress
            progress={stats.status.maxBytes > 0
              ? Math.min(100, Math.round((stats.status.usedBytes / stats.status.maxBytes) * 100))
              : 0}
            height="h-1.5"
            barClass={stats.status.level === 'normal' ? 'bg-[var(--ema-primary)]' : 'bg-[var(--ema-danger)]'}
          />
          <p className="mt-2 text-xs text-[var(--ema-text-tertiary)]">
            已用 {formatBytes(stats.status.usedBytes)} / 上限 {formatBytes(stats.status.maxBytes)}
            ，剩余 {formatBytes(stats.status.remainingBytes)}
          </p>
        </Card>
      )}

      {/* Active jobs */}
      {activeJobs.length > 0 && (
        <Callout variant="warn">
          <span className="font-semibold">后台任务进行中</span>
          <div className="mt-1 flex flex-col gap-0.5">
            {activeJobs.map((job) => (
              <div key={job.id} className="text-xs text-[var(--ema-warning-text)]">
                {JOB_KIND_LABEL[job.kind]} · {JOB_STATUS_LABEL[job.status]} · {relativeTime(job.createdAt)}
              </div>
            ))}
          </div>
        </Callout>
      )}

      {/* Failed jobs */}
      {failedJobs.length > 0 && (
        <Callout variant="danger">
          <span className="font-semibold">后台记忆任务失败</span>
          <div className="mt-1 flex flex-col gap-1">
            {failedJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 break-words">
                  {JOB_KIND_LABEL[job.kind]}：{job.error ?? '未知错误'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void useMemoryStore.getState().retryJob(job.id)
                      .catch((err: Error) => showToast(`重试失败: ${err.message}`, { variant: 'danger' }));
                  }}
                >
                  重试
                </Button>
              </div>
            ))}
          </div>
        </Callout>
      )}

      <Divider />
      <MemoryMaintenanceSettings />
    </div>
  );
}
