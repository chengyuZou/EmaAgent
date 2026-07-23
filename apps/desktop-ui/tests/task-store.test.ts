// 验证持久 Task 快照加载、事件更新，以及加载期间事件不会被旧快照覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { TaskSnapshot } from '@ema-agent/tasks';
import { tasksApi } from '../src/api/tasks.js';
import { useTaskStore } from '../src/stores/taskStore.js';

const SESSION_ID = 'task-store-session' as SessionId;

beforeEach(() => {
  vi.restoreAllMocks();
  useTaskStore.setState({
    tasksBySession: new Map(),
    loadingSessions: new Set(),
    errors: new Map(),
    eventRevisions: new Map(),
  });
});

describe('Task store', () => {
  it('加载 Session 快照并合并后续 Task 事件', async () => {
    vi.spyOn(tasksApi, 'list').mockResolvedValueOnce({ tasks: [task('1', 1)] });
    await useTaskStore.getState().loadForSession(SESSION_ID);

    useTaskStore.getState().upsert(task('2', 2, 'in_progress'));
    const sessionTasks = useTaskStore.getState().tasksBySession.get(SESSION_ID as string);
    expect([...sessionTasks?.keys() ?? []]).toEqual(['1', '2']);

    useTaskStore.getState().remove(SESSION_ID, '1' as TaskId);
    expect(sessionTasks?.get('1')?.status).toBe('pending');
    expect(useTaskStore.getState().tasksBySession.get(SESSION_ID as string)?.has('1')).toBe(false);
  });

  it('加载期间收到事件时丢弃旧响应并重新读取权威快照', async () => {
    let resolveFirst: ((value: { tasks: TaskSnapshot[] }) => void) | undefined;
    const first = new Promise<{ tasks: TaskSnapshot[] }>((resolve) => {
      resolveFirst = resolve;
    });
    vi.spyOn(tasksApi, 'list')
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ tasks: [task('2', 2, 'in_progress')] });

    const loading = useTaskStore.getState().loadForSession(SESSION_ID);
    useTaskStore.getState().upsert(task('2', 2, 'in_progress'));
    resolveFirst?.({ tasks: [task('1', 1)] });
    await loading;

    await vi.waitFor(() => {
      const tasks = useTaskStore.getState().tasksBySession.get(SESSION_ID as string);
      expect(tasks?.has('1')).toBe(false);
      expect(tasks?.get('2')?.status).toBe('in_progress');
    });
    expect(tasksApi.list).toHaveBeenCalledTimes(2);
  });
});

function task(
  id: string,
  displayNumber: number,
  status: TaskSnapshot['status'] = 'pending',
): TaskSnapshot {
  return {
    id: id as TaskId,
    sessionId: SESSION_ID,
    displayNumber,
    subject: `Task ${id}`,
    description: '',
    status,
    blocks: [],
    blockedBy: [],
    createdByTurnId: 'turn-1' as TurnId,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
