export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  sessionId: string;
  /** Session 内用于展示的短序号. 更新任务仍使用 id. */
  displayNumber: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  createdByTurnId: string;
  completedByTurnId?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskCreateInput {
  sessionId: string;
  turnId: string;
  subject: string;
  description: string;
  activeForm?: string;
}

export type TaskUpdateAction = 'cancel' | 'delete';

export interface TaskUpdateInput {
  sessionId: string;
  turnId: string;
  taskId: string;
  /** 使用最近一次读取的版本. 版本不匹配时拒绝覆盖, 并返回当前任务. */
  expectedVersion: number;
  subject?: string;
  description?: string;
  /** undefined 保持原值, null 清除当前进行中的描述. */
  activeForm?: string | null;
  status?: 'pending' | 'in_progress' | 'completed';
  action?: TaskUpdateAction;
}

export type TaskMutationFailure = 'not_found' | 'version_conflict' | 'invalid_update';

export type TaskUpdateResult =
  | { ok: true; changed: boolean; deleted: false; task: Task }
  | { ok: true; changed: true; deleted: true; taskId: string }
  | { ok: false; reason: TaskMutationFailure; current?: Task };
