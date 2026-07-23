// 在输入框上方展示当前 Session 的持久 Task、依赖与活动 AgentRun。
import type { JSX } from 'react';
import type { TaskSnapshot } from '@ema-agent/turn';

export function TaskList({ tasks }: { tasks: readonly TaskSnapshot[] }): JSX.Element {
  const ordered = [...tasks].sort((left, right) => {
    const leftTerminal = left.status === 'completed' || left.status === 'cancelled';
    const rightTerminal = right.status === 'completed' || right.status === 'cancelled';
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    return left.displayNumber - right.displayNumber;
  });
  const byId = new Map(tasks.map((task) => [task.id as string, task]));

  return (
    <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-1)] p-1.5 shadow-[var(--ema-shadow-2)]">
      {ordered.map((task) => (
        <TaskRow key={task.id} task={task} byId={byId} />
      ))}
    </div>
  );
}

function TaskRow({
  task,
  byId,
}: {
  task: TaskSnapshot;
  byId: ReadonlyMap<string, TaskSnapshot>;
}): JSX.Element {
  const unresolved = task.blockedBy
    .map((taskId) => byId.get(taskId as string))
    .filter((dependency) => dependency && dependency.status !== 'completed');
  const blocked = unresolved.length > 0;
  const label = task.status === 'in_progress'
    ? task.activeForm ?? task.subject
    : task.subject;

  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--ema-surface-2)]">
      <span className={`${taskIcon(task.status, blocked)} mt-0.5 shrink-0 text-sm`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11px] text-[var(--ema-text-tertiary)]">
            #{task.displayNumber}
          </span>
          <span className="truncate text-xs text-[var(--ema-text-primary)]">{label}</span>
          {task.activeAgentRunId && (
            <span className="i-lucide:bot shrink-0 text-xs text-[var(--ema-primary)]" title="子 Agent 执行中" />
          )}
        </div>
        {blocked && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--ema-warning-text)]">
            等待 {unresolved.map((dependency) => `#${dependency?.displayNumber}`).join('、')}
          </p>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-[var(--ema-text-tertiary)]">
        {taskStatusLabel(task.status, blocked)}
      </span>
    </div>
  );
}

function taskIcon(status: TaskSnapshot['status'], blocked: boolean): string {
  if (status === 'completed') return 'i-lucide:check text-[var(--ema-success)]';
  if (status === 'cancelled') return 'i-lucide:x text-[var(--ema-text-tertiary)]';
  if (blocked) return 'i-lucide:circle-pause text-[var(--ema-warning)]';
  if (status === 'in_progress') return 'i-lucide:loader-circle animate-spin text-[var(--ema-primary)]';
  return 'i-lucide:circle text-[var(--ema-text-tertiary)]';
}

function taskStatusLabel(status: TaskSnapshot['status'], blocked: boolean): string {
  if (blocked) return '被阻塞';
  if (status === 'in_progress') return '执行中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '待处理';
}
