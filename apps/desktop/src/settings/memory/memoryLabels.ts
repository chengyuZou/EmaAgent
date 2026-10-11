import type { BadgeVariant } from '@ema-agent/ui';
import type { MemoryJob } from '../../api/memory.js';

type JobKind = MemoryJob['kind'];
type JobStatus = MemoryJob['status'];

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  work_extraction:           '工作提取',
  relationship_extraction:   '关系提取',
  work_consolidation:        '工作整合',
  relationship_consolidation:'关系整合',
  work_maintenance:          '工作记忆维护',
  relationship_maintenance:  '关系记忆维护',
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending:   '排队中',
  running:   '运行中',
  completed: '已完成',
  failed:    '失败',
};

export const JOB_STATUS_VARIANT: Record<JobStatus, BadgeVariant> = {
  pending:   'neutral',
  running:   'primary',
  completed: 'success',
  failed:    'danger',
};

export const JOB_RESULT_LABEL: Record<NonNullable<MemoryJob['result']>, string> = {
  no_content: '没有可保存内容',
  awaiting_consolidation: '提取内容已保存, 等待整理',
  consolidated: '提取内容已参与整合',
  consolidation_completed: '整合完成',
  maintenance_completed: '维护完成',
};

export const MEMORY_TIME_RANGE_LABEL = {
  today: '今天',
  yesterday: '昨天',
  week: '近 7 天',
  month: '近 30 天',
  'this-month': '本月',
  'last-month': '上月',
  all: '全部',
} as const;

export type MemoryTimeRange = keyof typeof MEMORY_TIME_RANGE_LABEL;

export const MEMORY_TIME_RANGES = Object.entries(MEMORY_TIME_RANGE_LABEL).map(
  ([value, label]) => ({ value, label }),
);

const jobDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatJobTime(ms: number): string {
  return jobDateFormatter.format(ms);
}

export function memoryTimeRange(range: MemoryTimeRange): { startAt?: number; endAt?: number } {
  if (range === 'all') return {};
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  switch (range) {
    case 'today':
      break;
    case 'yesterday':
      end.setTime(start.getTime());
      start.setDate(start.getDate() - 1);
      break;
    case 'week':
      start.setDate(start.getDate() - 6);
      break;
    case 'month':
      start.setDate(start.getDate() - 29);
      break;
    case 'this-month':
      start.setDate(1);
      break;
    case 'last-month':
      start.setDate(1);
      end.setTime(start.getTime());
      start.setMonth(start.getMonth() - 1);
      break;
  }
  return { startAt: start.getTime(), endAt: end.getTime() };
}

export function formatMemoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}
