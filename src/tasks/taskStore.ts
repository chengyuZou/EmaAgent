// TaskStore 把 SQLite 原子操作映射成稳定工作项，并保持 Task 与 AgentRun 生命周期独立。

import { randomUUID } from 'node:crypto';
import type {
  TaskMutationResult as RepoMutationResult,
  TaskRow,
  TasksRepo,
} from '@ema-agent/storage';
import type {
  Task,
  TaskCreateInput,
  TaskMutationFailure,
  TaskUpdateInput,
  TaskUpdateResult,
} from './types.js';

const DEFAULT_REMINDER_TURNS = 10;

export class TaskStore {
  constructor(private readonly repo: TasksRepo) {}

  create(input: TaskCreateInput): Task {
    const row = this.repo.create({
      id: randomUUID(),
      sessionId: input.sessionId,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      createdByTurnId: input.turnId,
      createdAt: Date.now(),
    });
    return this.mapRows(input.sessionId, [row])[0]!;
  }

  get(sessionId: string, taskId: string): Task | undefined {
    const row = this.repo.findById(taskId, sessionId);
    return row ? this.mapRows(sessionId, [row])[0] : undefined;
  }

  list(sessionId: string): Task[] {
    return this.mapRows(sessionId, this.repo.listForSession(sessionId));
  }

  update(input: TaskUpdateInput): TaskUpdateResult {
    if (
      input.action !== undefined
      && (
        input.status !== undefined
        || input.subject !== undefined
        || input.description !== undefined
        || input.activeForm !== undefined
      )
    ) {
      return { ok: false, reason: 'invalid_update' };
    }

    if (input.action === 'delete') {
      const deleted = this.repo.delete(
        input.taskId,
        input.sessionId,
        input.expectedVersion,
      );
      if (deleted.ok) {
        return { ok: true, changed: true, deleted: true, taskId: input.taskId };
      }
      return {
        ok: false,
        reason: deleted.reason,
        ...(deleted.current
          ? { current: this.mapRows(input.sessionId, [deleted.current])[0]! }
          : {}),
      };
    }

    const now = Date.now();
    const targetStatus = input.action === 'cancel' ? 'cancelled' : input.status;
    const completion = targetStatus === 'completed' || targetStatus === 'cancelled';
    const result = this.repo.mutate({
      id: input.taskId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      patch: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
        ...(targetStatus !== undefined ? { status: targetStatus } : {}),
        ...(completion
          ? { completedByTurnId: input.turnId, completedAt: now }
          : targetStatus !== undefined
            ? { completedByTurnId: null, completedAt: null }
            : {}),
      },
      updatedAt: now,
    });
    return this.mapMutationResult(input.sessionId, result);
  }

  /** 只检查是否到了提醒周期（不消费）；提醒随 reminder 落库后由宿主调 markReminded 提交。 */
  shouldRemind(
    sessionId: string,
    minimumTurns = DEFAULT_REMINDER_TURNS,
  ): boolean {
    return this.repo.shouldRemind(sessionId, minimumTurns);
  }

  /** reminder Message 成功持久化后调用，提交"已提醒"并推进下一提醒周期基准。 */
  markReminded(sessionId: string): void {
    this.repo.markReminded(sessionId, Date.now());
  }

  private mapMutationResult(
    sessionId: string,
    result: RepoMutationResult,
  ): TaskUpdateResult {
    if (result.ok) {
      return {
        ok: true,
        changed: result.changed,
        deleted: false,
        task: this.mapRows(sessionId, [result.row])[0]!,
      };
    }
    return {
      ok: false,
      reason: result.reason as TaskMutationFailure,
      ...(result.current
        ? { current: this.mapRows(sessionId, [result.current])[0]! }
        : {}),
    };
  }

  private mapRows(sessionId: string, rows: readonly TaskRow[]): Task[] {
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      displayNumber: row.display_number,
      subject: row.subject,
      description: row.description,
      status: row.status,
      createdByTurnId: row.created_by_turn_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.active_form !== null ? { activeForm: row.active_form } : {}),
      ...(row.completed_by_turn_id !== null
        ? { completedByTurnId: row.completed_by_turn_id }
        : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    }));
  }
}
