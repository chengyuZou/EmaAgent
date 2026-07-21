// 这里放 AgentTask 模块的基础类型：任务状态、任务记录、状态转换动作和结果。

import type { AskUserQuestionSpec } from '@ema-agent/turn';

// ── 任务状态 ───────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ── Agent 任务 ─────────────────────────────────────────────────────────────────

export interface AgentTask {
  /** 根任务：等于 turnId。子 Agent 任务：全新的 UUID。 */
  id:        string;
  sessionId: string;
  /** 子 Agent 任务没有 DB turn 记录时为 null。 */
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
