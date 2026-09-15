// 保存各 Session 的持久 Task；修改统一经过根 Turn 的 Task 工具，
// 持久 Task 变更事件与 Turn 终态都可触发会话任务重查。
import { create } from 'zustand';

import { tasksApi, type TaskItem } from '../api/tasks.js';
import type { AppEvent } from '@ema-agent/server/application/appEvents.js';

interface TaskStoreState {
  tasksBySession: Map<string, Map<string, TaskItem>>;
  loadingSessions: Set<string>;
  errors: Map<string, string>;
  loadForSession(sessionId: string, force?: boolean): Promise<void>;
  evictSession(sessionId: string): void;
}

const queuedTaskRefreshes = new Set<string>();
const taskRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasksBySession: new Map(),
  loadingSessions: new Set(),
  errors: new Map(),

  async loadForSession(sessionId, force = false) {
    const key = sessionId;
    if (get().loadingSessions.has(key)) {
      if (force) queuedTaskRefreshes.add(key);
      return;
    }
    if (!force && get().tasksBySession.has(key)) return;

    set((state) => ({
      loadingSessions: addValue(state.loadingSessions, key),
      errors: withoutKey(state.errors, key),
    }));
    try {
      const result = await tasksApi.list(sessionId);
      set((state) => {
        const tasksBySession = new Map(state.tasksBySession);
        tasksBySession.set(
          key,
          new Map(result.tasks.map((task) => [task.id, task])),
        );
        return {
          tasksBySession,
          loadingSessions: withoutValue(state.loadingSessions, key),
        };
      });
    } catch (error) {
      set((state) => {
        const errors = new Map(state.errors);
        errors.set(key, error instanceof Error ? error.message : 'Task 列表加载失败');
        return {
          errors,
          loadingSessions: withoutValue(state.loadingSessions, key),
        };
      });
    } finally {
      if (queuedTaskRefreshes.delete(key)) void get().loadForSession(key, true);
    }
  },

  evictSession(sessionId) {
    const key = sessionId;
    clearTimeout(taskRefreshTimers.get(key));
    taskRefreshTimers.delete(key);
    queuedTaskRefreshes.delete(key);
    set((state) => ({
      tasksBySession: withoutKey(state.tasksBySession, key),
      loadingSessions: withoutValue(state.loadingSessions, key),
      errors: withoutKey(state.errors, key),
    }));
  },
}));

export function handleTaskSystemEvent(event: AppEvent): void {
  if (event.type !== 'tasks_changed') return;
  if (!useTaskStore.getState().tasksBySession.has(event.sessionId)) return;
  const sessionId = event.sessionId;
  clearTimeout(taskRefreshTimers.get(sessionId));
  taskRefreshTimers.set(sessionId, setTimeout(() => {
    taskRefreshTimers.delete(sessionId);
    void useTaskStore.getState().loadForSession(sessionId, true);
  }, 150));
}

function addValue<T>(source: Set<T>, value: T): Set<T> {
  return new Set(source).add(value);
}

function withoutKey<K, V>(source: Map<K, V>, key: K): Map<K, V> {
  const next = new Map(source);
  next.delete(key);
  return next;
}

function withoutValue<T>(source: Set<T>, value: T): Set<T> {
  const next = new Set(source);
  next.delete(value);
  return next;
}
