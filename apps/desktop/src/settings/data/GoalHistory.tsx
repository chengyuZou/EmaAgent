// 设置页只读展示一个 Session 的 Goal 历史; 长条读摘要, 展开后才读完整记录.
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { Skeleton } from '@ema-agent/ui';
import { goalsApi, type Goal, type GoalSummary } from '../../api/goals.js';
import { subscribeSystemEvent } from '../../lib/system-event-dispatcher.js';
import { fmtDateFull } from './storageFormat.js';

function statusLabel(goal: GoalSummary): string {
  if (goal.status === 'active') return '进行中';
  if (goal.status === 'paused') return '已暂停';
  if (goal.reason === 'succeeded') return '已完成';
  if (goal.reason === 'failed') return '最终失败';
  return '已取消';
}

function statusColor(goal: GoalSummary): string {
  if (goal.status === 'active') return 'var(--ema-success)';
  if (goal.status === 'paused') return 'var(--ema-warning)';
  if (goal.reason === 'failed') return 'var(--ema-danger)';
  return 'var(--ema-text-tertiary)';
}

export function GoalHistory({ sessionId }: { sessionId: string }): JSX.Element {
  const [items, setItems] = useState<GoalSummary[]>([]);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'goal_deleted') {
        if (event.sessionId !== sessionId) return;
        if (event.goalId === openGoalId) setOpenGoalId(null);
        setRevision(current => current + 1);
        return;
      }
      if ('goal' in event && event.goal.sessionId === sessionId) {
        setRevision(current => current + 1);
      }
    });
    return unsubscribe;
  }, [sessionId, openGoalId]);

  useEffect(() => {
    let active = true;
    goalsApi.list(sessionId).then(result => {
      if (!active) return;
      setItems(result.items);
      setListError(false);
    }).catch(() => {
      if (active) setListError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [sessionId, revision]);

  if (loading) {
    return <div className="flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;
  }
  if (listError) {
    return <p className="py-10 text-center text-xs text-[var(--ema-danger)]">目标记录读取失败</p>;
  }
  if (items.length === 0) {
    return <p className="py-10 text-center text-xs text-[var(--ema-text-tertiary)]">这个会话还没有目标记录</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((goal, index) => (
        <GoalHistoryRow
          key={goal.id}
          goal={goal}
          index={index}
          open={openGoalId === goal.id}
          revision={revision}
          onToggle={() => setOpenGoalId(current => current === goal.id ? null : goal.id)}
        />
      ))}
    </div>
  );
}

function GoalHistoryRow({ goal, index, open, revision, onToggle }: {
  goal: GoalSummary;
  index: number;
  open: boolean;
  revision: number;
  onToggle(): void;
}): JSX.Element {
  const [detail, setDetail] = useState<Goal | null>(null);
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    goalsApi.get(goal.sessionId, goal.id).then(result => {
      if (!active) return;
      setDetail(result.goal);
      setDetailError(false);
    }).catch(() => {
      if (active) setDetailError(true);
    });
    return () => { active = false; };
  }, [goal.sessionId, goal.id, open, revision]);

  return (
    <div
      className="ema-stagger-in-swift ema-material-section ema-glass-weak overflow-hidden rounded-xl border
        border-[var(--ema-border)] transition-colors hover:border-[var(--ema-primary)]/30"
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <button
        type="button"
        className="ema-card-decorate ema-card-decorate--lines flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left"
        onClick={onToggle}
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
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
        aria-hidden={!open}
        data-testid="goal-details"
      >
        <div>
          {(open || detail || detailError) && (
            <div className="flex flex-col gap-4 border-t border-[var(--ema-border)] px-5 py-4 text-sm text-[var(--ema-text-primary)]">
              {detailError ? (
                <p className="text-xs text-[var(--ema-danger)]">目标详情读取失败</p>
              ) : detail ? (
                <>
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
                </>
              ) : (
                <p className="text-xs text-[var(--ema-text-tertiary)]">正在读取目标详情…</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
