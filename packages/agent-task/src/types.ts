import type { AskUserQuestionSpec } from '@ema-agent/contracts';

// ── TaskStatus ────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'pending'       // created, not yet started
  | 'running'       // agentLoop active
  | 'waiting_user'  // blocked on ask_user tool response
  | 'completed'
  | 'failed'
  | 'cancelled';

// ── AgentTask ─────────────────────────────────────────────────────────────────

export interface AgentTask {
  /** Equals turnId for root tasks; a fresh UUID for subagent tasks. */
  id:          string;
  sessionId:   string;
  /** null for subagent tasks that don't have a DB turn record. */
  turnId:      string | null;
  parentId:    string | null;  // null = root task
  status:      TaskStatus;
  createdAt:   number;
  updatedAt:   number;
  /** Absolute path to the JSONL journal file for this task. */
  journalPath: string;
  /** Populated when status === 'waiting_user'. */
  pendingPromptId?:   string;
  pendingQuestions?:  AskUserQuestionSpec[];
  error?:             string;
}

// ── TaskJournalEntry — one line per JSONL record ──────────────────────────────

export type TaskJournalEntry =
  | { type: 'task_created';       taskId: string; sessionId: string; turnId: string | null; parentId: string | null; ts: number }
  | { type: 'task_started';       ts: number }
  | { type: 'task_waiting_user';  promptId: string; questions: AskUserQuestionSpec[]; ts: number }
  | { type: 'task_user_answered'; promptId: string; ts: number }
  | { type: 'task_resumed';       ts: number }
  | { type: 'task_completed';     iterations: number; inputTokens: number; outputTokens: number; ts: number }
  | { type: 'task_failed';        reason: string; ts: number }
  | { type: 'task_cancelled';     reason: string; ts: number };
