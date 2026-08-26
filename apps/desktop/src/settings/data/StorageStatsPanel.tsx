// 未选中会话时右窗格的总体统计:会话/轮次/消息等计数卡与音频、附件规模。
import type { JSX } from 'react';
import {
  Skeleton, StatCard as UIStatCard,
} from '@ema-agent/ui';
import type { DataDirStats } from '../../api/system.js';
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
  stats:        DataDirStats | null;
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
    <div className="ema-slide-down grid grid-cols-2 gap-3 p-6">
      <StatCard index={0} icon="i-solar:chat-round-bold-duotone"      label="会话"     value={String(stats.sessionCount)} />
      <StatCard index={1} icon="i-solar:refresh-circle-bold-duotone"  label="轮次"     value={String(stats.turnCount)} />
      <StatCard index={2} icon="i-solar:letter-bold-duotone"          label="消息"     value={String(stats.messageCount)} />
      <StatCard index={3} icon="i-solar:checklist-bold-duotone"       label="任务"     value={String(stats.taskCount)} />
      <StatCard index={4} icon="i-solar:magic-stick-3-bold-duotone"   label="子智能体执行" value={String(stats.agentRunCount)} />
      <StatCard index={5} icon="i-solar:paperclip-bold-duotone"       label="附件"     value={String(stats.attachmentCount)} />
      <StatCard index={6} icon="i-solar:soundwave-bold-duotone"       label="音频轮次" value={String(stats.audioCount)}    sub={fmtDuration(stats.audioDurationMs)} />
      <StatCard index={7} icon="i-solar:microphone-bold-duotone"      label="语音分段" value={String(stats.speechSegmentCount)} sub={fmtBytes(stats.speechSegmentBytes)} />
    </div>
  );
}

export function EmptyRight({ stats, statsLoading }: {
  stats: DataDirStats | null;
  statsLoading: boolean;
}): JSX.Element {
  return (
    <div className="ema-slide-in-right flex flex-col h-full overflow-y-auto">
      <StatsPanel stats={stats} statsLoading={statsLoading} />
    </div>
  );
}
