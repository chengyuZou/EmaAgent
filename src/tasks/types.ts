export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  sessionId: string;
  displayNumber: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: readonly string[];
  blockedBy: readonly string[];
  activeAgentRunId?: string;
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
  expectedVersion: number;
  subject?: string;
  description?: string;
  activeForm?: string | null;
  status?: 'pending' | 'in_progress' | 'completed';
  action?: TaskUpdateAction;
  addBlocks?: readonly string[];
  addBlockedBy?: readonly string[];
  removeBlocks?: readonly string[];
  removeBlockedBy?: readonly string[];
}

export type TaskMutationFailure =
  | 'not_found'
  | 'version_conflict'
  | 'blocked'
  | 'active_agent_run'
  | 'dependency_not_found'
  | 'dependency_cycle'
  | 'invalid_update';

export type TaskUpdateResult =
  | { ok: true; changed: boolean; deleted: false; task: Task }
  | { ok: true; changed: true; deleted: true; taskId: string }
  | { ok: false; reason: TaskMutationFailure; current?: Task; taskId?: string };
