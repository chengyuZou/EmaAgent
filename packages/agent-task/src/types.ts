import type { AskUserQuestionSpec } from '@ema-agent/contracts';

// ── TaskStatus ────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ── AgentTask ─────────────────────────────────────────────────────────────────

export interface AgentTask {
  /** Root tasks: equals turnId.  Subagent tasks: a fresh UUID. */
  id:        string;
  sessionId: string;
  /** null for subagent tasks that have no DB turn record. */
  turnId:    string | null;
  parentId:  string | null;
  status:    TaskStatus;
  /** 每次合法状态转换递增；用于拒绝过期异步结果。 */
  version:   number;
  createdAt: number;
  updatedAt: number;
  pendingPromptId?:  string;
  pendingQuestions?: AskUserQuestionSpec[];
  error?:            string;
}

export type TaskTransitionAction =
  | 'wait_user'
  | 'user_answered'
  | 'complete'
  | 'fail'
  | 'cancel';

/**
 * 状态转换不通过异常打断 Agent 流，而是返回可判别结果。
 * 过期 Worker 可以安全丢弃 conflict，HTTP Facade 则可将其映射为 409。
 */
export type TaskTransitionResult =
  | { ok: true; changed: boolean; task: AgentTask }
  | {
      ok: false;
      reason: 'not_found' | 'conflict';
      action: TaskTransitionAction;
      current?: AgentTask;
    };
