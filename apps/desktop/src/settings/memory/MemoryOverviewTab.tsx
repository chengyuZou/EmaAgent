import { useEffect, useState, type JSX } from 'react';
import { Badge, Button, Callout, Card, Progress, Spinner } from '@ema-agent/ui';
import { memoryApi, type MemoryStats } from '../../api/memory.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';

const LEVEL_LABEL = {
  normal: '正常',
  warning: '接近上限',
  limitExceeded: '已超限',
} as const;

export function MemoryOverviewTab(): JSX.Element {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void memoryApi.stats()
      .then(value => {
        setStats(value);
        setError(null);
      })
      .catch(reason => setError(errorMessage(reason, '读取 Memory 容量失败')));
  }, []);

  if (!stats && !error) {
    return <div className="flex justify-center py-16"><Spinner size="md" /></div>;
  }

  const progress = stats
    ? Math.min(100, Math.round((stats.usedBytes / stats.maxBytes) * 100))
    : 0;

  return (
    <div className="flex flex-col gap-4">
      {error && <Callout variant="danger">{error}</Callout>}
      {stats && (
        <Card
          variant="glass"
          padding="md"
          className="ema-card-decorate ema-card-decorate--starfield ema-stagger-in transition-all hover:border-[var(--ema-primary)] hover:shadow-[var(--ema-shadow-2)]"
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="i-lucide:database text-xl text-[var(--ema-primary)]" aria-hidden />
            <h3 className="text-sm font-semibold text-[var(--ema-text-primary)]">本地 Memory 存储</h3>
            <Badge
              className="ml-auto"
              variant={stats.level === 'normal' ? 'success' : stats.level === 'warning' ? 'warn' : 'danger'}
              dot
            >
              {LEVEL_LABEL[stats.level]}
            </Badge>
          </div>
          <Progress
            progress={progress}
            height="h-2"
            barClass={stats.level === 'normal'
              ? 'bg-[var(--ema-primary)]'
              : stats.level === 'warning'
                ? 'bg-[var(--ema-warning)]'
                : 'bg-[var(--ema-danger)]'}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--ema-text-tertiary)]">
            <span>已用 {formatBytes(stats.usedBytes)} / {formatBytes(stats.maxBytes)}</span>
            <span>剩余 {formatBytes(stats.remainingBytes)}</span>
            <Button
              variant="ghost"
              size="sm"
              icon="i-lucide:folder-open"
              className="ml-auto"
              onClick={() => void tauriBridge.openPath(stats.rootPath)
                .catch(reason => setError(errorMessage(reason, '打开 Memory 文件夹失败')))}
            >
              打开文件夹
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <TrackCard
          icon="i-lucide:briefcase-business"
          title="Work"
          description="全局共享的工作偏好、习惯、协作方式与长期约束。"
          detail="不记录代码、工具输出和每日工作日志。"
        />
        <TrackCard
          icon="i-lucide:heart-handshake"
          title="Relationship"
          description="共享关系信息，以及按角色名称分开的角色关系记忆。"
          detail="只有带角色归属的 Turn 才会自动提取。"
        />
      </div>
    </div>
  );
}

function TrackCard(props: {
  icon: string;
  title: string;
  description: string;
  detail: string;
}): JSX.Element {
  return (
    <Card
      variant="glass"
      padding="md"
      className="ema-card-decorate ema-card-decorate--plus ema-stagger-in transition-all hover:-translate-y-0.5 hover:border-[var(--ema-primary)] hover:shadow-[var(--ema-shadow-2)]"
    >
      <span className={`${props.icon} text-2xl text-[var(--ema-primary)]`} aria-hidden />
      <h3 className="mt-2 text-sm font-semibold text-[var(--ema-text-primary)]">{props.title}</h3>
      <p className="mt-1 text-xs text-[var(--ema-text-secondary)]">{props.description}</p>
      <p className="mt-2 text-[11px] text-[var(--ema-text-tertiary)]">{props.detail}</p>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
