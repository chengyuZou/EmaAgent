// SessionSidePanel 按 Goal ID 打开的编辑页. 正文草稿独立于事件更新的 Goal 事实.
import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, IconButton, Textarea, Tooltip } from '@ema-agent/ui';
import { goalsApi, type Goal } from '../../../../api/goals.js';
import { ServerApiError } from '../../../../api/client.js';
import { subscribeSystemEvent } from '../../../../lib/system-event-dispatcher.js';

export function GoalPanel({ sessionId, goalId }: {
  sessionId: string;
  goalId: string;
}): JSX.Element {
  const [editor, setEditor] = useState<{
    goal: Goal | null;
    text: string;
    expectedVersion: number | null;
    loading: boolean;
    saving: boolean;
    error: string | null;
  }>({ goal: null, text: '', expectedVersion: null, loading: true, saving: false, error: null });
  const readVersion = useRef(0);

  async function readGoal(replaceDraft: boolean): Promise<void> {
    const request = ++readVersion.current;
    setEditor(current => ({ ...current, loading: true, error: null }));
    try {
      const { goal } = await goalsApi.get(sessionId, goalId);
      if (request !== readVersion.current) return;
      setEditor(current => ({
        ...current,
        goal,
        text: replaceDraft ? goal.objective : current.text,
        expectedVersion: replaceDraft ? goal.version : current.expectedVersion,
        loading: false,
      }));
    } catch (error) {
      if (request !== readVersion.current) return;
      setEditor(current => ({
        ...current,
        goal: error instanceof ServerApiError && error.status === 404 ? null : current.goal,
        loading: false,
        error: error instanceof Error ? error.message : '目标读取失败',
      }));
    }
  }

  useEffect(() => {
    const unsubscribe = subscribeSystemEvent(event => {
      if (event.type === 'goal_deleted') {
        if (event.sessionId !== sessionId || event.goalId !== goalId) return;
        readVersion.current += 1;
        setEditor(current => ({ ...current, goal: null, loading: false, error: '目标已删除, 未保存的文字仍可复制.' }));
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
          if (event.goal.sessionId !== sessionId || event.goal.id !== goalId) return;
          readVersion.current += 1;
          setEditor(current => ({
            ...current,
            goal: event.goal,
            text: current.expectedVersion === null ? event.goal.objective : current.text,
            expectedVersion: current.expectedVersion ?? event.goal.version,
            loading: false,
          }));
          break;
        }
      }
    });
    void readGoal(true);
    return () => {
      readVersion.current += 1;
      unsubscribe();
    };
  }, [sessionId, goalId]);

  const unfinished = editor.goal?.status === 'active' || editor.goal?.status === 'paused';
  const changed = editor.goal !== null && editor.expectedVersion !== editor.goal.version;

  async function save(): Promise<void> {
    if (!unfinished || editor.loading || editor.saving || changed || editor.expectedVersion === null || !editor.text.trim()) return;
    setEditor(current => ({ ...current, saving: true, error: null }));
    try {
      const { goal } = await goalsApi.edit(goalId, {
        sessionId,
        expectedVersion: editor.expectedVersion,
        objective: editor.text,
      });
      setEditor(current => ({
        ...current,
        // 更晚的关闭/删除事件不能被保存请求的旧响应覆盖.
        goal: current.goal && current.goal.version < goal.version ? goal : current.goal,
        expectedVersion: goal.version,
        saving: false,
      }));
    } catch (error) {
      await readGoal(false);
      setEditor(current => ({
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : '保存目标失败',
      }));
    }
  }

  let status = '目标不存在';
  if (editor.loading) status = '正在读取目标';
  else if (editor.goal?.status === 'active') status = '进行中';
  else if (editor.goal?.status === 'paused') status = '已暂停';
  else if (editor.goal?.status === 'completed') status = '已关闭';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-tertiary)]">{status}</span>
        <Tooltip content="重新读取目标正文, 替换未保存的文字">
          <IconButton size="sm" variant="ghost" icon="i-lucide:rotate-ccw" label="重新读取目标"
            disabled={editor.loading || editor.saving} onClick={() => void readGoal(true)} />
        </Tooltip>
        <Button size="sm" variant="secondary" disabled={!unfinished || editor.loading || editor.saving || changed || !editor.text.trim()}
          onClick={() => void save()}>{editor.saving ? '保存中…' : '保存'}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <Textarea 
          value={editor.text} 
          onChange={event => setEditor(current => ({ ...current, text: event.target.value }))}
          aria-label="目标正文" placeholder="目标正文" minRows={12} maxRows={30}
          readOnly={!unfinished || editor.loading || editor.saving} 
          className="min-h-[64px] w-full resize-none border-none overflow-y-auto rounded-[22px] bg-transparent px-4 py-3 text-sm text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)] focus:outline-none"
        />
        {changed && <p role="status" className="mt-3 text-xs text-[var(--ema-warning)]">
          目标已更新, 未保存的文字已保留. 请先核对并重新读取目标, 不会自动重试旧版本保存.
        </p>}
        {!editor.loading && editor.goal?.status === 'completed' && <p role="status" className="mt-3 text-xs text-[var(--ema-text-tertiary)]">
          目标已关闭, 不能继续编辑或恢复. 未保存的文字仍可复制.
        </p>}
        {editor.goal?.feedback && <div className="mt-4">
          <p className="mb-1 text-xs text-[var(--ema-text-tertiary)]">最近进度</p>
          <p className="whitespace-pre-wrap break-words text-sm text-[var(--ema-text-secondary)]">{editor.goal.feedback}</p>
        </div>}
        {editor.error && <p role="alert" className="mt-3 text-sm text-[var(--ema-danger)]">{editor.error}</p>}
      </div>
    </div>
  );
}
