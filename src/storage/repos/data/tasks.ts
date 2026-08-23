// Task 数据库操作在单个事务内完成 CAS 更新与短序号分配。

import type { SqliteDb } from '../../database/database.js';

export type TaskRowStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TaskRow {
  id: string;
  session_id: string;
  display_number: number;
  subject: string;
  description: string;
  active_form: string | null;
  status: TaskRowStatus;
  created_by_turn_id: string;
  completed_by_turn_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TaskCreateRow {
  id: string;
  sessionId: string;
  subject: string;
  description: string;
  activeForm?: string;
  createdByTurnId: string;
  createdAt: number;
}

export interface TaskRowPatch {
  subject?: string;
  description?: string;
  activeForm?: string | null;
  status?: TaskRowStatus;
  completedByTurnId?: string | null;
  completedAt?: number | null;
}

export interface TaskMutation {
  id: string;
  sessionId: string;
  expectedVersion: number;
  patch: TaskRowPatch;
  updatedAt: number;
}

export type TaskMutationFailure = 'not_found' | 'version_conflict';

export type TaskMutationResult =
  | { ok: true; changed: boolean; row: TaskRow }
  | { ok: false; reason: TaskMutationFailure; current?: TaskRow };

export type TaskDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'version_conflict'; current?: TaskRow };

export class TasksRepo {
  constructor(private readonly db: SqliteDb) {}

  create(input: TaskCreateRow): TaskRow {
    return this.db.transaction(() => {
      const displayNumber = this.db.prepare(
        `SELECT COALESCE(MAX(display_number), 0) + 1
           FROM tasks
          WHERE session_id = ?`,
      ).pluck().get(input.sessionId) as number;

      this.db.prepare(
        `INSERT INTO tasks (
           id, session_id, display_number, subject, description, active_form,
           status, created_by_turn_id, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`,
      ).run(
        input.id,
        input.sessionId,
        displayNumber,
        input.subject,
        input.description,
        input.activeForm ?? null,
        input.createdByTurnId,
        input.createdAt,
        input.createdAt,
      );

      return this.findById(input.id, input.sessionId)!;
    })();
  }

  findById(id: string, sessionId: string): TaskRow | undefined {
    return this.db.prepare(
      `${TASK_SELECT}
        WHERE task.id = ? AND task.session_id = ?`,
    ).get(id, sessionId) as TaskRow | undefined;
  }

  listForSession(sessionId: string): TaskRow[] {
    return this.db.prepare(
      `${TASK_SELECT}
        WHERE task.session_id = ?
        ORDER BY task.display_number ASC, task.id ASC`,
    ).all(sessionId) as TaskRow[];
  }

  mutate(input: TaskMutation): TaskMutationResult {
    return this.db.transaction(() => {
      const current = this.findById(input.id, input.sessionId);
      if (!current) return { ok: false, reason: 'not_found' } as const;
      if (current.version !== input.expectedVersion) {
        return { ok: false, reason: 'version_conflict', current } as const;
      }

      const changed = patchChangesRow(current, input.patch);
      if (!changed) {
        return { ok: true, changed: false, row: current } as const;
      }

      const next = mergedRow(current, input.patch);
      const updated = this.db.prepare(
        `UPDATE tasks
            SET subject = ?,
                description = ?,
                active_form = ?,
                status = ?,
                completed_by_turn_id = ?,
                completed_at = ?,
                version = version + 1,
                updated_at = ?
          WHERE id = ? AND session_id = ? AND version = ?`,
      ).run(
        next.subject,
        next.description,
        next.active_form,
        next.status,
        next.completed_by_turn_id,
        next.completed_at,
        input.updatedAt,
        input.id,
        input.sessionId,
        input.expectedVersion,
      );
      if (updated.changes !== 1) {
        const raced = this.findById(input.id, input.sessionId);
        return raced
          ? { ok: false, reason: 'version_conflict', current: raced } as const
          : { ok: false, reason: 'not_found' } as const;
      }

      return {
        ok: true,
        changed: true,
        row: this.findById(input.id, input.sessionId)!,
      } as const;
    })();
  }

  delete(
    id: string,
    sessionId: string,
    expectedVersion: number,
  ): TaskDeleteResult {
    return this.db.transaction(() => {
      const current = this.findById(id, sessionId);
      if (!current) return { ok: false, reason: 'not_found' } as const;
      if (current.version !== expectedVersion) {
        return { ok: false, reason: 'version_conflict', current } as const;
      }
      const result = this.db.prepare(
        'DELETE FROM tasks WHERE id = ? AND session_id = ? AND version = ?',
      ).run(id, sessionId, expectedVersion);
      return result.changes === 1
        ? { ok: true } as const
        : { ok: false, reason: 'version_conflict', current: this.findById(id, sessionId) } as const;
    })();
  }

  /** 只检查是否到了提醒周期，不写任何状态；调用方在提醒落库成功后调 markReminded 提交。 */
  shouldRemind(
    sessionId: string,
    minimumTurns: number,
  ): boolean {
    const latestTaskUpdate = this.db.prepare(
      `SELECT MAX(updated_at)
         FROM tasks
        WHERE session_id = ?
          AND status IN ('pending', 'in_progress')`,
    ).pluck().get(sessionId) as number | null;
    if (latestTaskUpdate === null) return false;

    const lastRemindedAt = this.db.prepare(
      'SELECT last_reminded_at FROM task_context_state WHERE session_id = ?',
    ).pluck().get(sessionId) as number | undefined;
    const since = Math.max(latestTaskUpdate, lastRemindedAt ?? latestTaskUpdate);
    const turnCount = this.db.prepare(
      `SELECT COUNT(*)
         FROM turns
        WHERE session_id = ?
          AND created_at > ?`,
    ).pluck().get(sessionId, since) as number;
    return turnCount >= minimumTurns;
  }

  /** reminder Message 成功持久化后显式提交"已提醒"，避免 Turn 准备失败吞掉提醒周期。 */
  markReminded(sessionId: string, now: number): void {
    this.db.prepare(
      `INSERT INTO task_context_state (session_id, last_reminded_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_reminded_at = excluded.last_reminded_at`,
    ).run(sessionId, now);
  }
}

function patchChangesRow(current: TaskRow, patch: TaskRowPatch): boolean {
  return (
    (patch.subject !== undefined && patch.subject !== current.subject)
    || (patch.description !== undefined && patch.description !== current.description)
    || (patch.activeForm !== undefined && patch.activeForm !== current.active_form)
    || (patch.status !== undefined && patch.status !== current.status)
    || (
      patch.completedByTurnId !== undefined
      && patch.completedByTurnId !== current.completed_by_turn_id
    )
    || (
      patch.completedAt !== undefined
      && patch.completedAt !== current.completed_at
    )
  );
}

function mergedRow(current: TaskRow, patch: TaskRowPatch): TaskRow {
  return {
    id: current.id,
    session_id: current.session_id,
    display_number: current.display_number,
    subject: patch.subject ?? current.subject,
    description: patch.description ?? current.description,
    active_form: patch.activeForm !== undefined ? patch.activeForm : current.active_form,
    status: patch.status ?? current.status,
    created_by_turn_id: current.created_by_turn_id,
    completed_by_turn_id: patch.completedByTurnId !== undefined
      ? patch.completedByTurnId
      : current.completed_by_turn_id,
    version: current.version,
    created_at: current.created_at,
    updated_at: current.updated_at,
    completed_at: patch.completedAt !== undefined
      ? patch.completedAt
      : current.completed_at,
  };
}

const TASK_SELECT = `SELECT task.*
    FROM tasks task`;
