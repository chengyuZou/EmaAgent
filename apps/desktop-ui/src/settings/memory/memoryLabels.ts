// 标签映射辅助函数

import type { MemoryNodeType, MemoryItemKind } from '@ema-agent/storage';

// ── Label maps ────────────────────────────────────────────────────────────────

export const NODE_TYPE_LABEL: Record<MemoryNodeType, string> = {
  user_fact:    '事实',
  entity:       '实体',
  event:        '事件',
  emotion:      '情感',
  preference:   '偏好',
  relationship: '关系',
};

export const NODE_TYPE_VARIANT: Record<MemoryNodeType, 'primary' | 'neutral' | 'warn' | 'violet' | 'success'> = {
  user_fact:    'primary',
  entity:       'neutral',
  event:        'warn',
  emotion:      'success',
  preference:   'violet',
  relationship: 'neutral',
};

export const ITEM_KIND_LABEL: Record<MemoryItemKind, string> = {
  user:      '用户',
  feedback:  '反馈',
  project:   '项目',
  reference: '参考',
};

export const ITEM_KIND_VARIANT: Record<MemoryItemKind, 'primary' | 'neutral' | 'warn' | 'violet'> = {
  user:      'primary',
  feedback:  'warn',
  project:   'violet',
  reference: 'neutral',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)          return '刚刚';
  if (diff < 3_600_000)       return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000)      return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

export function importanceBarClass(importance: number): string {
  if (importance < 0.3) return 'bg-[var(--ema-text-tertiary)]';
  if (importance < 0.7) return 'bg-[var(--ema-primary)]';
  return 'bg-[var(--ema-success)]';
}