import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, IconButton, Tooltip } from '@ema-agent/ui';
import type { PermissionMode } from '@ema-agent/permission';
import { goalsApi, type Goal } from '../../../api/goals.js';
import { ServerApiError } from '../../../api/client.js';
import { SessionRequestError } from '../../../api/sessionWebSocket.js';
import { useChatNavigationStore } from '../../../stores/chatNavigation.js';
import { useSessionStore } from '../../../stores/session.js';
import { useSessionPanelStore } from '../../../stores/sessionPanel.js';
import { subscribeSystemEvent } from '../../../lib/system-event-dispatcher.js';
import { showToast } from '../../../lib/toast.js';

export function useInputGoal(viewedId: string | null, permissionMode: PermissionMode, serverReady: boolean) {
  const [goalRead, setGoalRead] = useState<{
    sessionId: string | null;
    goal: Goal | null;
    loading: boolean;
    error: string | null;
  }>({ sessionId: null, goal: null, loading: false, error: null });
  const [goalIntent, setGoalIntent] = useState<string | null>(null);
  const [goalPending, setGoalPending] = useState<string | null>(null);
  const goalRequest = useRef<AbortController | null>(null);
  const goalLoaded = goalRead.sessionId === viewedId && !goalRead.loading && !goalRead.error;
  const currentGoal = goalRead.sessionId === viewedId ? goalRead.goal : null;
  const creatingGoal = viewedId !== null && goalIntent === viewedId;
  const goalAvailable = viewedId !== null && permissionMode !== 'plan' && goalLoaded && serverReady;
  let planUnavailableReason: string | undefined;
  if (viewedId) {
    if (currentGoal) {
      planUnavailableReason = '请先关闭当前 Goal, 暂停目标仍不能开启 Plan';
    } else if (creatingGoal) {
      planUnavailableReason = '请先取消输入框的目标标记';
    } else if (goalRead.sessionId === viewedId && goalRead.error) {
      planUnavailableReason = '目标读取失败, 请重试后再开启 Plan';
    } else if (!goalLoaded) {
      planUnavailableReason = '正在核对当前目标';
    }
  }

  async function readCurrentGoal(sessionId: string): Promise<void> {
    if (useChatNavigationStore.getState().viewedSessionId !== sessionId) return;
    goalRequest.current?.abort();
    const controller = new AbortController();
    goalRequest.current = controller;
    setGoalRead(current => ({ ...current, sessionId, loading: true, error: null }));
    try {
      const { goal } = await goalsApi.current(sessionId, controller.signal);
      if (!controller.signal.aborted) setGoalRead({ sessionId, goal, loading: false, error: null });
    } catch (error) {
      if (!controller.signal.aborted) {
        setGoalRead(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : '目标读取失败' }));
      }
    }
  }

  useEffect(() => {
    setGoalIntent(null);
    setGoalRead({ sessionId: viewedId, goal: null, loading: viewedId !== null, error: null });
    if (!viewedId || !serverReady) return;
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'goal_deleted') {
        if (event.sessionId !== viewedId) return;
        goalRequest.current?.abort();
        setGoalRead(current => ({
          ...current,
          goal: current.goal?.id === event.goalId ? null : current.goal,
          loading: false,
          error: null,
        }));
        return;
      }
      switch (event.type) {
        case 'goal_created':
        case 'goal_edited':
        case 'goal_updated':
        case 'goal_paused':
        case 'goal_activated':
        case 'goal_completed':
        case 'goal_failed':
        case 'goal_cancelled': {
          if (event.goal.sessionId !== viewedId) return;
          goalRequest.current?.abort();
          const goal = event.goal;
          setGoalRead(current => {
            let nextGoal = current.goal;
            if (goal.status !== 'completed') nextGoal = goal;
            else if (current.goal?.id === goal.id) nextGoal = null;
            return { sessionId: viewedId, goal: nextGoal, loading: false, error: null };
          });
          if (goal.status !== 'completed') setGoalIntent(null);
          break;
        }
      }
    });
    void readCurrentGoal(viewedId);
    return () => {
      goalRequest.current?.abort();
      unsubscribe();
    };
  }, [viewedId, serverReady]);

  function editGoal(): void {
    if (!viewedId || !currentGoal) return;
    useSessionPanelStore.getState().openTab(viewedId, { id: currentGoal.id, kind: 'goal' });
  }

  async function changeGoal(action: 'pause' | 'activate' | 'cancel'): Promise<void> {
    if (!viewedId || !currentGoal || !goalLoaded || goalPending === viewedId) return;
    const sessionId = viewedId;
    const goalId = currentGoal.id;
    setGoalPending(sessionId);
    try {
      const { goal } = await goalsApi[action](goalId, { sessionId, expectedVersion: currentGoal.version });
      // 已交付的删除或新目标事件优先于旧操作响应, 不复活已关闭的 Goal.
      setGoalRead(current => {
        if (current.sessionId !== sessionId || current.goal?.id !== goalId || current.goal.version > goal.version) return current;
        return { sessionId, goal: goal.status === 'completed' ? null : goal, loading: false, error: null };
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '目标操作失败', { variant: 'danger' });
      await readCurrentGoal(sessionId);
      if (error instanceof ServerApiError && error.code === 'goal_plan_conflict') {
        await useSessionStore.getState().loadSessions();
      }
    } finally {
      setGoalPending(current => current === sessionId ? null : current);
    }
  }

  function beginGoal(): boolean {
    if (!viewedId) return false;
    if (!goalAvailable) {
      showToast('请先关闭 Plan 并等待目标信息读取完成', { variant: 'warning' });
      return false;
    }
    if (currentGoal) editGoal();
    else setGoalIntent(viewedId);
    return true;
  }

  function cancelGoalIntent(): void {
    setGoalIntent(null);
  }

  function finishSubmission(): void {
    setGoalIntent(current => current === viewedId ? null : current);
  }

  function refreshGoal(): void {
    if (viewedId) void readCurrentGoal(viewedId);
  }

  function refreshAfterSubmissionError(error: unknown): void {
    refreshGoal();
    if (error instanceof SessionRequestError && error.code === 'goal_plan_conflict') {
      void useSessionStore.getState().loadSessions();
    }
  }

  return {
    currentGoal,
    creatingGoal,
    goalAvailable,
    planUnavailableReason,
    readError: goalRead.sessionId === viewedId ? goalRead.error : null,
    reading: goalRead.loading,
    disabled: !goalLoaded || goalPending === viewedId || !serverReady,
    editGoal,
    changeGoal,
    beginGoal,
    cancelGoalIntent,
    finishSubmission,
    refreshGoal,
    refreshAfterSubmissionError,
  };
}

export function InputGoalBar({ goal }: { goal: ReturnType<typeof useInputGoal> }): JSX.Element {
  return (
    <>
      {goal.readError && (
        <div role="alert" className="mb-2 flex items-center gap-2 px-2 text-xs text-[var(--ema-danger)]">
          <span className="min-w-0 flex-1">目标读取失败: {goal.readError}</span>
          <Button size="sm" variant="ghost" disabled={goal.reading} onClick={goal.refreshGoal}>重试</Button>
        </div>
      )}
      {goal.currentGoal && (
        <GoalBar
          goal={goal.currentGoal}
          disabled={goal.disabled}
          onClose={() => void goal.changeGoal('cancel')}
          onTogglePause={() => void goal.changeGoal(goal.currentGoal!.status === 'active' ? 'pause' : 'activate')}
          onEdit={goal.editGoal}
        />
      )}
    </>
  );
}

function GoalBar({ goal, disabled, onClose, onTogglePause, onEdit }: {
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
