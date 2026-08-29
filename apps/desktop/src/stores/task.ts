// 保存各 Session 的持久 Task；修改统一经过根 Turn 的 Task 工具，
// Turn 终态是会话级任务的唯一刷新节拍（任务没有独立事件流）。
import { create } from 'zustand';

import { tasksApi, type TaskItem } from '../api/tasks.js';

interface TaskStoreState {
  tasksBySession: Map<string, Map<string, TaskItem>>;
  loadingSessions: Set<string>;
  errors: Map<string, string>;
  loadForSession(sessionId: string, force?: boolean): Promise<void>;
  evictSession(sessionId: string): void;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasksBySession: new Map(),
  loadingSessions: new Set(),
  errors: new Map(),

  async loadForSession(sessionId, force = false) {
    const key = sessionId;
    if (get().loadingSessions.has(key)) return;
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
    }
  },

  evictSession(sessionId) {
    const key = sessionId;
    set((state) => ({
      tasksBySession: withoutKey(state.tasksBySession, key),
      loadingSessions: withoutValue(state.loadingSessions, key),
      errors: withoutKey(state.errors, key),
    }));
  },
}));

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
