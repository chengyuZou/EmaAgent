// ChatInput 的当前目标展示条. 数据和操作由输入区提供, 这里不查询或保存 Goal.
import type { JSX } from 'react';
import { IconButton, Tooltip } from '@ema-agent/ui';
import type { Goal } from '../../api/goals.js';

export function GoalBar({ goal, disabled, onClose, onTogglePause, onEdit }: {
  goal: Goal;
  disabled: boolean;
  onClose(): void;
  onTogglePause(): void;
  onEdit(): void;
}): JSX.Element {
  const active = goal.status === 'active';

  return (
    <div className="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-2)] px-3 py-2">
      <span className="i-lucide:goal shrink-0 text-sm text-[var(--ema-text-secondary)]" aria-hidden />
      <button type="button" className="min-w-0 flex-1 text-left" disabled={disabled} onClick={onEdit}>
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="shrink-0 font-medium text-[var(--ema-text-primary)]">
            {active ? '进行中的目标' : '已暂停的目标'}
          </span>
          <span className="truncate text-[var(--ema-text-secondary)]" title={goal.objective}>{goal.objective}</span>
        </div>
      </button>
      <Tooltip content="关闭目标, 保留历史; 不停止当前 Turn">
        <IconButton size="sm" variant="ghost" icon="i-lucide:circle-x" label="关闭目标" disabled={disabled} onClick={onClose} />
      </Tooltip>
      <Tooltip content={active ? '暂停自动续接, 不停止当前 Turn' : '激活目标'}>
        <IconButton size="sm" variant="ghost" icon={active ? 'i-lucide:pause' : 'i-lucide:play'}
          label={active ? '暂停目标' : '激活目标'} disabled={disabled} onClick={onTogglePause} />
      </Tooltip>
      <Tooltip content="编辑目标">
        <IconButton size="sm" variant="ghost" icon="i-lucide:pencil" label="编辑目标" disabled={disabled} onClick={onEdit} />
      </Tooltip>
    </div>
  );
}
