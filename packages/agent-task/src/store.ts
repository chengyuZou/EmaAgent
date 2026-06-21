import type { AskUserQuestionSpec } from '@ema-agent/contracts';
import type { AgentTask, TaskStatus } from './types.js';
import type { AgentTasksRepo, AgentTaskRow } from '@ema-agent/storage';

// ── Row → domain ──────────────────────────────────────────────────────────────

function rowToTask(row: AgentTaskRow): AgentTask {
  return {
    id:        row.id,
    sessionId: row.session_id,
    turnId:    row.turn_id,
    parentId:  row.parent_id,
    status:    row.status as TaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.pending_prompt_id
      ? { pendingPromptId: row.pending_prompt_id }
      : {}),
    ...(row.pending_questions_json
      ? { pendingQuestions: JSON.parse(row.pending_questions_json) as AskUserQuestionSpec[] }
      : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

// ── AgentTaskStore ────────────────────────────────────────────────────────────
//
// SQL-backed registry for all agent runs (root turns + subagent spawns).
//
// Concurrency model: JS is single-threaded; claim() is synchronous inside
// SQLite's synchronous driver, so no two microtasks race on the same taskId.
//
// Crash recovery: at startup call recoverInterrupted() to mark orphaned
// 'running'/'waiting_user' tasks as 'failed' and surface any 'waiting_user'
// tasks that need their question widgets re-presented.

export class AgentTaskStore {
  constructor(private readonly repo: AgentTasksRepo) {}

  // ── Claim ─────────────────────────────────────────────────────────────────

  /**
   * Atomically create and register a task. Idempotent: if taskId already
   * exists (duplicate call) returns the existing row unchanged.
   */
  claim(args: {
    taskId:    string;
    sessionId: string;
    turnId:    string | null;
    parentId:  string | null;
  }): AgentTask {
    const existing = this.repo.findById(args.taskId);
    if (existing) return rowToTask(existing);

    const now = Date.now();
    this.repo.insert({
      id:        args.taskId,
      sessionId: args.sessionId,
      turnId:    args.turnId,
      parentId:  args.parentId,
      createdAt: now,
    });
    return rowToTask(this.repo.findById(args.taskId)!);
  }

  // ── Status transitions ────────────────────────────────────────────────────

  waitUser(taskId: string, promptId: string, questions: AskUserQuestionSpec[]): void {
    this.repo.waitUser(taskId, promptId, questions, Date.now());
  }

  userAnswered(taskId: string, _promptId: string): void {
    this.repo.userAnswered(taskId, Date.now());
  }

  complete(taskId: string, stats: { iterations: number; inputTokens: number; outputTokens: number }): void {
    this.repo.complete(taskId, stats, Date.now());
  }

  fail(taskId: string, reason: string): void {
    this.repo.fail(taskId, reason, Date.now());
  }

  cancel(taskId: string, reason: string): void {
    this.repo.cancel(taskId, reason, Date.now());
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get(taskId: string): AgentTask | undefined {
    const row = this.repo.findById(taskId);
    return row ? rowToTask(row) : undefined;
  }

  listForSession(sessionId: string): AgentTask[] {
    return this.repo.listForSession(sessionId).map(rowToTask);
  }

  listRunning(): AgentTask[] {
    return this.repo.listRunning().map(rowToTask);
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  /** Hard-delete a task and its messages (cascades via FK). */
  delete(taskId: string): void {
    this.repo.delete(taskId);
  }

  /**
   * Batch-delete all terminal tasks for a session (completed/failed/cancelled).
   * Returns the count deleted.
   */
  clearTerminalForSession(sessionId: string): number {
    return this.repo.deleteTerminalForSession(sessionId);
  }

  // ── Startup crash recovery ────────────────────────────────────────────────

  /**
   * Mark orphaned tasks failed; return a summary for startup logging.
   * 'waiting_user' tasks are left in their state (UI re-presents the widget).
   */
  recoverInterrupted(): {
    recovered:   AgentTask[];
    waitingUser: AgentTask[];
  } {
    const all = this.repo.listRunning();

    const waitingUser = all
      .filter(r => r.status === 'waiting_user')
      .map(rowToTask);

    const stuck = this.repo.markStuckFailed(Date.now());
    const recovered = stuck.map(rowToTask);

    return { recovered, waitingUser };
  }
}
