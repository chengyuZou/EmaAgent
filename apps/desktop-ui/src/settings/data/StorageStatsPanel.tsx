// 未选中会话时右窗格的总体统计:路径、计数卡与磁盘占用分布。
import type { CSSProperties, JSX } from 'react';
import {
  Progress, Skeleton, StatCard as UIStatCard,
} from '@ema-agent/ui';
import type { StorageStatsWire } from '../../api/storage.js';
import { fmtBytes, fmtDuration } from './storageFormat.js';

function StatCard({
  label, value, sub, icon, index,
}: {
  label: string; value: string; sub?: string; icon: string; index: number;
}): JSX.Element {
  return (
    <UIStatCard label={label} value={value} sub={sub} icon={icon} index={index} size="md" decorate="ema-card-decorate--storage" />
  );
}

export function StatsPanel({ stats, statsLoading }: {
  stats:        StorageStatsWire | null;
  statsLoading: boolean;
}): JSX.Element {
  if (statsLoading && !stats) {
    return (
      <div className="ema-slide-down grid grid-cols-2 gap-3 p-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="ema-slide-down flex flex-col items-center justify-center h-full gap-3 text-[var(--ema-text-tertiary)]">
        <span className="i-solar:database-bold-duotone text-4xl" aria-hidden />
        <p className="text-sm inline-flex items-center gap-1"><span className="i-mdi:arrow-left" aria-hidden />从左侧选择会话查看详情</p>
      </div>
    );
  }

  return (
    <div className="ema-slide-down flex flex-col gap-6 p-6">
      <div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mb-1">当前路径</p>
        <p className="text-sm font-mono text-[var(--ema-text-secondary)] selectable break-all">{stats.path}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard index={0} icon="i-solar:chat-round-bold-duotone"      label="会话"     value={String(stats.sessionCount)} />
        <StatCard index={1} icon="i-solar:refresh-circle-bold-duotone"  label="轮次"     value={String(stats.turnCount)} />
        <StatCard index={2} icon="i-solar:letter-bold-duotone"          label="消息"     value={String(stats.messageCount)} />
        <StatCard index={4} icon="i-solar:soundwave-bold-duotone"       label="音频轮次" value={String(stats.audioCount)}    sub={fmtDuration(stats.audioDurationMs)} />
        <StatCard index={5} icon="i-solar:magic-stick-3-bold-duotone"   label="子智能体执行" value={String(stats.agentRunCount)} />
      </div>

      <div className="ema-stagger-in ema-glass-weak ema-card-decorate ema-card-decorate--storage bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] p-4 shadow-[var(--ema-shadow-1)]"
           style={{ '--stagger-i': 6 } as CSSProperties}>
        <p className="text-xs font-medium text-[var(--ema-text-secondary)] mb-3">磁盘占用</p>
        <div className="flex flex-col gap-2">
          {([
            ['数据库',   stats.dataDbBytes],
            ['音频文件', stats.audioBytes],
            ['会话文件', stats.sessionsBytes],
          ] as [string, number][]).map(([label, bytes], i) => (
            <div key={label} className="ema-stagger-in" style={{ '--stagger-i': i + 7 } as CSSProperties}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-[var(--ema-text-tertiary)]">{label}</span>
                <span className="text-[var(--ema-text-secondary)] font-mono">{fmtBytes(bytes)}</span>
              </div>
              <Progress
                progress={stats.totalBytes > 0 ? Math.round((bytes / stats.totalBytes) * 100) : 0}
                height="h-1"
                barClass="bg-[var(--ema-primary)]"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--ema-text-tertiary)] mt-3 text-right">
          合计 {fmtBytes(stats.totalBytes)}
        </p>
      </div>
    </div>
  );
}

export function EmptyRight({ stats, statsLoading }: {
  stats: StorageStatsWire | null;
  statsLoading: boolean;
}): JSX.Element {
  return (
    <div className="ema-slide-in-right flex flex-col h-full overflow-y-auto">
      <StatsPanel stats={stats} statsLoading={statsLoading} />
    </div>
  );
}
