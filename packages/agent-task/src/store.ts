import type { AskUserQuestionSpec } from '@ema-agent/contracts';
import type {
  AgentTask,
  TaskStatus,
  TaskTransitionAction,
  TaskTransitionResult,
} from './types.js';
import type { AgentTasksRepo, AgentTaskRow } from '@ema-agent/storage';

// ── Row → domain ──────────────────────────────────────────────────────────────

function rowToTask(row: AgentTaskRow): AgentTask {
  return {
    id:        row.id,
    sessionId: row.session_id,
    turnId:    row.turn_id,
    parentId:  row.parent_id,
    status:    row.status as TaskStatus,
    version:   row.version,
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

  waitUser(
    taskId: string,
    promptId: string,
    questions: AskUserQuestionSpec[],
  ): TaskTransitionResult {
    const current = this.currentFor('wait_user', taskId);
    if (!current.ok) return current.result;
    if (current.row.status === 'waiting_user' && current.row.pending_prompt_id === promptId) {
      return { ok: true, changed: false, task: rowToTask(current.row) };
    }
    if (current.row.status !== 'running') return this.conflict('wait_user', current.row);

    const updated = this.repo.waitUser(
      taskId,
      current.row.version,
      promptId,
      questions,
      Date.now(),
    );
    return this.finishTransition('wait_user', taskId, updated);
  }

  userAnswered(taskId: string, promptId: string): TaskTransitionResult {
    const current = this.currentFor('user_answered', taskId);
    if (!current.ok) return current.result;
    if (
      current.row.status !== 'waiting_user'
      || current.row.pending_prompt_id !== promptId
    ) {
      return this.conflict('user_answered', current.row);
    }

    const updated = this.repo.userAnswered(
      taskId,
      current.row.version,
      promptId,
      Date.now(),
    );
    return this.finishTransition('user_answered', taskId, updated);
  }

  complete(
    taskId: string,
    stats: { iterations: number; inputTokens: number; outputTokens: number },
  ): TaskTransitionResult {
    const current = this.currentFor('complete', taskId);
    if (!current.ok) return current.result;
    if (current.row.status === 'completed') {
      return { ok: true, changed: false, task: rowToTask(current.row) };
    }
    if (current.row.status !== 'running') return this.conflict('complete', current.row);

    const updated = this.repo.complete(
      taskId,
      current.row.version,
      stats,
      Date.now(),
    );
    return this.finishTransition('complete', taskId, updated);
  }

  fail(taskId: string, reason: string): TaskTransitionResult {
    const current = this.currentFor('fail', taskId);
    if (!current.ok) return current.result;
    if (current.row.status === 'failed' && current.row.error === reason) {
      return { ok: true, changed: false, task: rowToTask(current.row) };
    }
    if (!isNonTerminal(current.row.status)) return this.conflict('fail', current.row);

    const updated = this.repo.fail(taskId, current.row.version, reason, Date.now());
    return this.finishTransition('fail', taskId, updated);
  }

  cancel(taskId: string, reason: string): TaskTransitionResult {
    const current = this.currentFor('cancel', taskId);
    if (!current.ok) return current.result;
    if (current.row.status === 'cancelled') {
      return { ok: true, changed: false, task: rowToTask(current.row) };
    }
    if (!isNonTerminal(current.row.status)) return this.conflict('cancel', current.row);

    const updated = this.repo.cancel(taskId, current.row.version, reason, Date.now());
    return this.finishTransition('cancel', taskId, updated);
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
   * Mark all orphaned tasks (running or waiting_user) as failed.
   * Returns the rows that were changed, for startup logging.
   */
  recoverInterrupted(): AgentTask[] {
    return this.repo.markStuckFailed(Date.now()).map(rowToTask);
  }

  // ── CAS helpers ──────────────────────────────────────────────────────────

  private currentFor(
    action: TaskTransitionAction,
    taskId: string,
  ):
    | { ok: true; row: AgentTaskRow }
    | { ok: false; result: TaskTransitionResult } {
    const row = this.repo.findById(taskId);
    if (row) return { ok: true, row };
    return { ok: false, result: { ok: false, reason: 'not_found', action } };
  }

  private finishTransition(
    action: TaskTransitionAction,
    taskId: string,
    updated: AgentTaskRow | undefined,
  ): TaskTransitionResult {
    if (updated) return { ok: true, changed: true, task: rowToTask(updated) };

    // UPDATE 影响 0 行意味着读取之后发生了并发状态或版本变化。
    const current = this.repo.findById(taskId);
    return current
      ? this.conflict(action, current)
      : { ok: false, reason: 'not_found', action };
  }

  private conflict(action: TaskTransitionAction, row: AgentTaskRow): TaskTransitionResult {
    return {
      ok: false,
      reason: 'conflict',
      action,
      current: rowToTask(row),
    };
  }
}

function isNonTerminal(status: TaskStatus): boolean {
  return status === 'running' || status === 'waiting_user';
}
