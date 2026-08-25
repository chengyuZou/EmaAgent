// 后台维护健康卡(M5):状态、当前维护动作、最近失败与存储压力的只读投影。
import { Badge, Card, type BadgeVariant } from '@ema-agent/ui';
import type { JSX } from 'react';
import type { MemoryBackgroundHealth } from '../../api/memory.js';
import type { MemoryBackgroundOperation } from '@ema-agent/memory';

const OPERATION_LABEL: Record<MemoryBackgroundOperation, string> = {
  initialization: '初始化',
  decay: '衰减维护',
  consolidation: '归并维护',
  embeddingRepair: '向量修复',
  storageBudget: '存储预算',
};

const STATE_META: Record<MemoryBackgroundHealth['state'], { label: string; variant: BadgeVariant }> = {
  idle:     { label: '正常',   variant: 'success' },
  running:  { label: '维护中', variant: 'primary' },
  degraded: { label: '已退化', variant: 'danger' },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function MemoryHealthCard({ health }: { health: MemoryBackgroundHealth }): JSX.Element {
  const meta = STATE_META[health.state];
  return (
    <Card variant="elevated" padding="sm" className="ema-card-decorate ema-card-decorate--starfield">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)]">后台维护</p>
        <Badge variant={meta.variant} dot={health.state === 'running'}>
          {meta.label}
          {health.state === 'running' && health.activeOperation
            ? ` · ${OPERATION_LABEL[health.activeOperation]}`
            : ''}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5 text-xs text-[var(--ema-text-tertiary)]">
        {health.lastFailure && (
          <span className="text-[var(--ema-warning)]">
            最近失败：{health.lastFailure.message}
            {health.consecutiveFailures > 0 ? `(连续 ${health.consecutiveFailures} 次)` : ''}
          </span>
        )}
        {health.lastCompletedAt !== undefined && !health.lastFailure && (
          <span>
            最近完成：{new Date(health.lastCompletedAt).toLocaleString()}
          </span>
        )}
        {health.storagePressure && (
          <span className={health.storagePressure.remainsOverLimit ? 'text-[var(--ema-danger)]' : ''}>
            存储压力：{formatBytes(health.storagePressure.usedBytes)}
            {' / '}{formatBytes(health.storagePressure.maxBytes)}
            {health.storagePressure.remainsOverLimit ? '(仍超限)' : ''}
          </span>
        )}
      </div>
    </Card>
  );
}
