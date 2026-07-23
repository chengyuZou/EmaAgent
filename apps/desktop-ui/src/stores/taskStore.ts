// 保存各 Session 的持久 Task 快照，并合并根 Turn 发来的 Task 事件。
import { create } from 'zustand';
import type { SessionId, TaskId } from '@ema-agent/ids';
import type { TaskSnapshot } from '@ema-agent/tasks';
import { tasksApi } from '../api/tasks.js';

interface TaskStoreState {
  tasksBySession: Map<string, Map<string, TaskSnapshot>>;
  loadingSessions: Set<string>;
  errors: Map<string, string>;
  eventRevisions: Map<string, number>;
  loadForSession(sessionId: SessionId, force?: boolean): Promise<void>;
  upsert(task: TaskSnapshot): void;
  remove(sessionId: SessionId, taskId: TaskId): void;
  evictSession(sessionId: SessionId): void;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasksBySession: new Map(),
  loadingSessions: new Set(),
  errors: new Map(),
  eventRevisions: new Map(),

  async loadForSession(sessionId, force = false) {
    const key = sessionId as string;
    if (get().loadingSessions.has(key)) return;
    if (!force && get().tasksBySession.has(key)) return;

    const requestedAtRevision = get().eventRevisions.get(key) ?? 0;
    set((state) => ({
      loadingSessions: addValue(state.loadingSessions, key),
      errors: withoutKey(state.errors, key),
    }));
    try {
      const result = await tasksApi.list(sessionId);
      if ((get().eventRevisions.get(key) ?? 0) !== requestedAtRevision) {
        set((state) => ({
          loadingSessions: withoutValue(state.loadingSessions, key),
        }));
        void get().loadForSession(sessionId, true);
        return;
      }
      set((state) => {
        const tasksBySession = new Map(state.tasksBySession);
        tasksBySession.set(
          key,
          new Map(result.tasks.map((task) => [task.id as string, task])),
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

  upsert(task) {
    set((state) => {
      const sessionKey = task.sessionId as string;
      const tasksBySession = new Map(state.tasksBySession);
      const eventRevisions = incrementRevision(state.eventRevisions, sessionKey);
      const sessionTasks = new Map(tasksBySession.get(sessionKey) ?? []);
      const current = sessionTasks.get(task.id as string);
      if (current && current.version >= task.version) {
        return { eventRevisions };
      }
      sessionTasks.set(task.id as string, task);
      tasksBySession.set(sessionKey, sessionTasks);
      return { tasksBySession, eventRevisions };
    });
  },

  remove(sessionId, taskId) {
    set((state) => {
      const sessionKey = sessionId as string;
      const current = state.tasksBySession.get(sessionKey);
      const eventRevisions = incrementRevision(state.eventRevisions, sessionKey);
      if (!current?.has(taskId as string)) return { eventRevisions };
      const tasksBySession = new Map(state.tasksBySession);
      const sessionTasks = new Map(current);
      sessionTasks.delete(taskId as string);
      tasksBySession.set(sessionKey, sessionTasks);
      return { tasksBySession, eventRevisions };
    });
  },

  evictSession(sessionId) {
    const key = sessionId as string;
    set((state) => ({
      tasksBySession: withoutKey(state.tasksBySession, key),
      loadingSessions: withoutValue(state.loadingSessions, key),
      errors: withoutKey(state.errors, key),
      eventRevisions: withoutKey(state.eventRevisions, key),
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

function incrementRevision(source: Map<string, number>, key: string): Map<string, number> {
  const next = new Map(source);
  next.set(key, (next.get(key) ?? 0) + 1);
  return next;
}
