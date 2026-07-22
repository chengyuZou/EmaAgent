// 这里管理 Agent 任务的生命周期：认领、状态转换（CAS 防过期覆盖）、查询、删除、崩溃恢复。

import type {
  AgentTask,
  TaskStatus,
  TaskTransitionAction,
  TaskTransitionResult,
} from './types.js';
import type { AgentTasksRepo, AgentTaskRow } from '@ema-agent/storage';

// ── 数据库行 -> 领域对象 ──────────────────────────────────────────────────────────

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
    ...(row.error ? { error: row.error } : {}),
  };
}

// ── AgentTaskStore ────────────────────────────────────────────────────────────
//
// 所有 Agent 运行（根 turn + 子 Agent spawn）的 SQL 持久化注册表。
//
// 并发模型：JS 单线程；claim() 在 SQLite 同步驱动里同步执行，
// 所以不会有两个微任务在同一个 taskId 上竞争。
//
// 崩溃恢复：启动时调 recoverInterrupted()，把孤儿 running 任务标为 failed。

export class AgentTaskStore {
  constructor(private readonly repo: AgentTasksRepo) {}

  // ── 认领 ───────────────────────────────────────────────────────────────────

  /**
   * 原子地创建并注册一个任务。幂等：taskId 已存在（重复调用）时原样返回已有行。
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

  // ── 状态转换 ────────────────────────────────────────────────────────────────

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

  // ── 查询 ───────────────────────────────────────────────────────────────────

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

  // ── 删除 ───────────────────────────────────────────────────────────────────

  /** 硬删除一个任务及其消息（通过 FK 级联）。 */
  delete(taskId: string): void {
    this.repo.delete(taskId);
  }

  /**
   * 批量删除一个 Session 的所有终态任务（completed/failed/cancelled）。
   * 返回删除数量。
   */
  clearTerminalForSession(sessionId: string): number {
    return this.repo.deleteTerminalForSession(sessionId);
  }

  // ── 启动崩溃恢复 ────────────────────────────────────────────────────────────

  /**
   * 把所有孤儿 running 任务标为 failed。
   * 返回被改动的行，供启动日志用。
   */
  recoverInterrupted(): AgentTask[] {
    return this.repo.markStuckFailed(Date.now()).map(rowToTask);
  }

  // ── CAS 辅助 ───────────────────────────────────────────────────────────────

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
  return status === 'running';
}
