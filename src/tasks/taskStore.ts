// TaskStore 把 SQLite 原子操作映射成稳定工作项，并保持 Task 与 AgentRun 生命周期独立。

import { randomUUID } from 'node:crypto';
import type {
  TaskDependencyRow,
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
        || input.addBlocks !== undefined
        || input.addBlockedBy !== undefined
        || input.removeBlocks !== undefined
        || input.removeBlockedBy !== undefined
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
      addBlocks: input.addBlocks ?? [],
      addBlockedBy: input.addBlockedBy ?? [],
      removeBlocks: input.removeBlocks ?? [],
      removeBlockedBy: input.removeBlockedBy ?? [],
      updatedAt: now,
    });
    return this.mapMutationResult(input.sessionId, result);
  }

  takeContextReminder(
    sessionId: string,
    minimumTurns = DEFAULT_REMINDER_TURNS,
  ): Task[] {
    if (!this.repo.shouldRemind(sessionId, minimumTurns, Date.now())) return [];
    return this.list(sessionId).filter(
      (task) => task.status === 'pending' || task.status === 'in_progress',
    );
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
      ...(result.taskId ? { taskId: result.taskId } : {}),
    };
  }

  private mapRows(sessionId: string, rows: readonly TaskRow[]): Task[] {
    const dependencies = this.repo.listDependenciesFor(
      sessionId,
      rows.map((row) => row.id),
    );
    const blocks = dependencyMap(dependencies, 'blocker_task_id', 'blocked_task_id');
    const blockedBy = dependencyMap(dependencies, 'blocked_task_id', 'blocker_task_id');
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      displayNumber: row.display_number,
      subject: row.subject,
      description: row.description,
      status: row.status,
      blocks: blocks.get(row.id) ?? [],
      blockedBy: blockedBy.get(row.id) ?? [],
      createdByTurnId: row.created_by_turn_id,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.active_form !== null ? { activeForm: row.active_form } : {}),
      ...(row.active_agent_run_id !== null
        ? { activeAgentRunId: row.active_agent_run_id }
        : {}),
      ...(row.completed_by_turn_id !== null
        ? { completedByTurnId: row.completed_by_turn_id }
        : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    }));
  }
}

function dependencyMap(
  rows: readonly TaskDependencyRow[],
  key: 'blocker_task_id' | 'blocked_task_id',
  value: 'blocker_task_id' | 'blocked_task_id',
): Map<string, string[]> {
  const mapped = new Map<string, string[]>();
  for (const row of rows) {
    const current = mapped.get(row[key]) ?? [];
    current.push(row[value]);
    mapped.set(row[key], current);
  }
  return mapped;
}
