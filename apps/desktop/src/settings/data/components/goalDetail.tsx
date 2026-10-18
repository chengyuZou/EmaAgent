import { memo, useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Button, Skeleton } from '@ema-agent/ui';
import { goalsApi, type Goal, type GoalSummary } from '../../../api/goals.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';
import { fmtDateFull } from '../storageFormat.js';
import { useCollapsibleBody } from '../../../chat/messages/messageExpansion.js';

function statusLabel(goal: GoalSummary): string {
  if (goal.status === 'active') {
    return '进行中';
  }
  if (goal.status === 'paused') {
    return '已暂停';
  }
  if (goal.reason === 'succeeded') {
    return '已完成';
  }
  if (goal.reason === 'failed') {
    return '最终失败';
  }
  return '已取消';
}

function statusColor(goal: GoalSummary): string {
  if (goal.status === 'active') {
    return 'var(--ema-success)';
  }
  if (goal.status === 'paused') {
    return 'var(--ema-warning)';
  }
  if (goal.reason === 'failed') {
    return 'var(--ema-danger)';
  }
  return 'var(--ema-text-tertiary)';
}

export function GoalDetail({ sessionId }: { sessionId: string }): JSX.Element {
  const [items, setItems] = useState<GoalSummary[]>([]);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'goal_deleted') {
        if (event.sessionId !== sessionId) {
          return;
        }
        setOpenGoalId(current => current === event.goalId ? null : current);
        setRevisions(current => {
          const next = new Map(current);
          next.delete(event.goalId);
          return next;
        });
        return;
      }
      if ('goal' in event && event.goal.sessionId === sessionId) {
        setRevisions(current => {
          const next = new Map(current);
          next.set(event.goal.id, (next.get(event.goal.id) ?? 0) + 1);
          return next;
        });
      }
    });
    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    goalsApi.list(sessionId, controller.signal).then(result => {
      if (controller.signal.aborted) {
        return;
      }
      setItems(current => {
        const previous = new Map(current.map(goal => [goal.id, goal]));
        return result.items.map(goal => {
          const old = previous.get(goal.id);
          const unchanged = old && (Object.keys(goal) as (keyof GoalSummary)[])
            .every(key => old[key] === goal[key]);
          return unchanged ? old : goal;
        });
      });
      setListError(false);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setListError(true);
      }
    }).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [sessionId, revisions]);

  const toggle = useCallback((goalId: string) => {
    setOpenGoalId(current => current === goalId ? null : goalId);
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map(index => <Skeleton key={index} className="h-16 rounded-xl" />)}
      </div>
    );
  }
  if (listError && items.length === 0) {
    return <p className="py-10 text-center text-xs text-[var(--ema-danger)]">目标记录读取失败</p>;
  }
  if (items.length === 0) {
    return <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">这个会话还没有目标记录</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {listError && <p className="text-xs text-[var(--ema-danger)]">刷新失败，保留已加载的目标记录</p>}
      {items.map((goal, index) => (
        <GoalRow
          key={goal.id}
          goal={goal}
          index={index}
          open={openGoalId === goal.id}
          revision={revisions.get(goal.id) ?? 0}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

const GoalRow = memo(function GoalRow({ goal, index, open, revision, onToggle }: {
  goal: GoalSummary;
  index: number;
  open: boolean;
  revision: number;
  onToggle(goalId: string): void;
}): JSX.Element {
  const { containerRef, mounted } = useCollapsibleBody(open);

  return (
    <div
      className="ema-stagger-in-swift ema-material-section ema-glass-weak overflow-hidden rounded-xl border
        border-[var(--ema-border)] transition-colors hover:border-[var(--ema-primary)]/30"
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <button
        type="button"
        className="ema-card-decorate ema-card-decorate--lines flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left"
        onClick={() => onToggle(goal.id)}
        aria-expanded={open}
      >
        <span className="i-lucide:goal shrink-0 text-base text-[var(--ema-primary)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs text-[var(--ema-text-secondary)]">
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor(goal) }} aria-hidden />
            <span>{statusLabel(goal)}</span>
            <span className="text-[var(--ema-text-tertiary)]">{fmtDateFull(goal.createdAt)}</span>
          </span>
          <span className="mt-1 block truncate text-sm text-[var(--ema-text-primary)]">{goal.objective}</span>
        </span>
        <span
          className="i-lucide:chevron-down shrink-0 text-xs text-[var(--ema-text-tertiary)]
            transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>
      <div
        ref={containerRef}
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
        aria-hidden={!open}
        data-testid="goal-details"
      >
        <div>
          {mounted && <GoalRecord goal={goal} revision={revision} />}
        </div>
      </div>
    </div>
  );
});

function GoalRecord({ goal, revision }: { readonly goal: GoalSummary; readonly revision: number }): JSX.Element {
  const [detail, setDetail] = useState<Goal | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void goalsApi.get(goal.sessionId, goal.id, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setDetail(result.goal);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setFailed(true);
      }
    });
    return () => controller.abort();
  }, [goal.sessionId, goal.id, revision, retry]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 px-5 py-4">
        <p className="text-xs text-[var(--ema-danger)]">目标详情读取失败</p>
        <Button variant="ghost" size="sm" onClick={() => setRetry(current => current + 1)}>重试</Button>
      </div>
    );
  }
  if (!detail) {
    return <Skeleton className="mx-5 my-4 h-16 rounded-lg" />;
  }
  return (
    <div className="flex flex-col gap-4 border-t border-[var(--ema-border)] px-5 py-4 text-sm text-[var(--ema-text-primary)]">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ema-text-tertiary)]">
        <span>建立于 {fmtDateFull(detail.createdAt)}</span>
        {detail.completedAt !== null && <span>结束于 {fmtDateFull(detail.completedAt)}</span>}
      </div>
      <section>
        <h3 className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">目标正文</h3>
        <p className="whitespace-pre-wrap break-words">{detail.objective}</p>
      </section>
      {detail.feedback && (
        <section>
          <h3 className="mb-1 text-xs font-semibold text-[var(--ema-text-secondary)]">最近累计进度</h3>
          <p className="whitespace-pre-wrap break-words">{detail.feedback}</p>
        </section>
      )}
      {detail.error && (
        <section>
          <h3 className="mb-1 text-xs font-semibold text-[var(--ema-danger)]">最终失败原因</h3>
          <p className="whitespace-pre-wrap break-words">{detail.error}</p>
        </section>
      )}
    </div>
  );
}
