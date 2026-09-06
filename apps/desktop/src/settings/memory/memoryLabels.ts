// Memory 后台任务与存储水位的中文展示标签;kind/status 映射表唯一事实源。
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

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)          return '刚刚';
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
