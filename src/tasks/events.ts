// 定义持久 Task 对外公开的变更事件;载荷直接复用领域 Task,不另建投影类型。
import type { SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { Task } from './types.js';

export type TaskEvent =
  | { type: 'task_created'; sessionId: SessionId; turnId: TurnId; task: Task }
  | { type: 'task_updated'; sessionId: SessionId; turnId: TurnId; task: Task }
  | { type: 'task_deleted'; sessionId: SessionId; turnId: TurnId; taskId: TaskId };
