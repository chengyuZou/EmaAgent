// 展示当前 Session 的持久 Task；修改仍由根 Agent 的 Task Tool 完成。
import { useEffect, useMemo, type JSX } from 'react';
import { Badge, Button, Spinner, type BadgeVariant } from '@ema-agent/ui';

import type { TaskItem } from '../../../../api/tasks.js';
import { useTaskStore } from '../../../../stores/task.js';

const STATUS_META: Record<TaskItem['status'], { label: string; badge: BadgeVariant; icon: string }> = {
  pending: { label: '等待中', badge: 'neutral', icon: 'i-lucide:circle' },
  in_progress: { label: '进行中', badge: 'primary', icon: 'i-lucide:loader-circle' },
  completed: { label: '已完成', badge: 'success', icon: 'i-lucide:circle-check' },
  cancelled: { label: '已取消', badge: 'neutral', icon: 'i-lucide:circle-slash' },
};

export function SessionTasksPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const tasks = useTaskStore((state) => sessionId ? state.tasksBySession.get(sessionId) : undefined);
  const loading = useTaskStore((state) => sessionId ? state.loadingSessions.has(sessionId) : false);
  const error = useTaskStore((state) => sessionId ? state.errors.get(sessionId) : undefined);
  const load = useTaskStore((state) => state.loadForSession);

  useEffect(() => {
    if (sessionId) void load(sessionId).catch(() => {});
  }, [sessionId, load]);

  const ordered = useMemo(() => [...(tasks?.values() ?? [])].sort((left, right) => {
    const rank = (status: TaskItem['status']): number => status === 'in_progress' ? 0 : status === 'pending' ? 1 : 2;
    return rank(left.status) - rank(right.status) || right.updatedAt - left.updatedAt;
  }), [tasks]);

  if (!sessionId) return <EmptyTasks text="请先选择会话" />;
  if (loading && !tasks) {
    return <div className="flex h-full items-center justify-center"><Spinner size="md" label="正在读取任务" /></div>;
  }
  if (error && !tasks) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-xs text-[var(--ema-danger)]">{error}</p>
        <Button size="sm" variant="secondary" onClick={() => void load(sessionId, true).catch(() => {})}>重新加载</Button>
      </div>
    );
  }
  if (ordered.length === 0) return <EmptyTasks text="当前会话还没有任务" />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="flex flex-col gap-1.5">
        {ordered.map((task) => {
          const meta = STATUS_META[task.status];
          return (
            <article key={task.id} className="rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`${meta.icon} shrink-0 text-sm text-[var(--ema-text-tertiary)] ${task.status === 'in_progress' ? 'animate-spin' : ''}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ema-text-primary)]">
                  #{task.displayNumber} {task.subject}
                </span>
                <Badge variant={meta.badge}>{meta.label}</Badge>
              </div>
              {task.description && <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-[var(--ema-text-secondary)]">{task.description}</p>}
              {task.status === 'in_progress' && task.activeForm && (
                <p className="mt-1 text-[10px] text-[var(--ema-primary)]">{task.activeForm}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function EmptyTasks({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
      <span className="i-lucide:list-checks text-3xl opacity-25" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
