// 定义持久 Task 对外公开的变更事件;载荷直接复用领域 Task,不另建投影类型。
import type { Task } from './types.js';

export type TaskEvent =
  | { type: 'task_created'; sessionId: string; turnId: string; task: Task }
  | { type: 'task_updated'; sessionId: string; turnId: string; task: Task }
  | { type: 'task_deleted'; sessionId: string; turnId: string; taskId: string };
