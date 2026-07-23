import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { TaskSnapshot } from '@ema-agent/turn';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Task {
  id: TaskId;
  sessionId: SessionId;
  displayNumber: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: readonly TaskId[];
  blockedBy: readonly TaskId[];
  activeAgentRunId?: AgentRunId;
  createdByTurnId: TurnId;
  completedByTurnId?: TurnId;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskCreateInput {
  sessionId: SessionId;
  turnId: TurnId;
  subject: string;
  description: string;
  activeForm?: string;
}

export type TaskUpdateAction = 'cancel' | 'delete';

export interface TaskUpdateInput {
  sessionId: SessionId;
  turnId: TurnId;
  taskId: TaskId;
  expectedVersion: number;
  subject?: string;
  description?: string;
  activeForm?: string | null;
  status?: 'pending' | 'in_progress' | 'completed';
  action?: TaskUpdateAction;
  addBlocks?: readonly TaskId[];
  addBlockedBy?: readonly TaskId[];
  removeBlocks?: readonly TaskId[];
  removeBlockedBy?: readonly TaskId[];
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
  | { ok: true; changed: true; deleted: true; taskId: TaskId }
  | { ok: false; reason: TaskMutationFailure; current?: Task; taskId?: TaskId };

export interface TaskStorePort {
  create(input: TaskCreateInput): Task;
  get(sessionId: SessionId, taskId: TaskId): Task | undefined;
  list(sessionId: SessionId): Task[];
  update(input: TaskUpdateInput): TaskUpdateResult;
  takeContextReminder(sessionId: SessionId, minimumTurns?: number): Task[];
  toSnapshot(task: Task): TaskSnapshot;
}
