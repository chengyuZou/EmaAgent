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
  createdAt: number;
  updatedAt: number;
  pendingPromptId?:  string;
  pendingQuestions?: AskUserQuestionSpec[];
  error?:            string;
}
