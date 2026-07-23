// 定义持久 Task 对外公开的快照与变更事件。
import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { TaskStatus } from './types.js';

export interface TaskSnapshot {
  id: TaskId;
  sessionId: SessionId;
  displayNumber: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: TaskId[];
  blockedBy: TaskId[];
  activeAgentRunId?: AgentRunId;
  createdByTurnId: TurnId;
  completedByTurnId?: TurnId;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type TaskEvent =
  | { type: 'task_created'; sessionId: SessionId; turnId: TurnId; task: TaskSnapshot }
  | { type: 'task_updated'; sessionId: SessionId; turnId: TurnId; task: TaskSnapshot }
  | { type: 'task_deleted'; sessionId: SessionId; turnId: TurnId; taskId: TaskId };
