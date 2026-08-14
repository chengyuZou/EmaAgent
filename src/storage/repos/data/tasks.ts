// Task 数据库操作在单个事务内完成 CAS 更新、依赖校验和短序号分配。

import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export type TaskRowStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TaskRow {
  id: TaskId;
  session_id: SessionId;
  display_number: number;
  subject: string;
  description: string;
  active_form: string | null;
  status: TaskRowStatus;
  created_by_turn_id: TurnId;
  completed_by_turn_id: TurnId | null;
  version: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  active_agent_run_id: AgentRunId | null;
}

export interface TaskDependencyRow {
  session_id: SessionId;
  blocker_task_id: TaskId;
  blocked_task_id: TaskId;
  created_at: number;
}

export interface TaskCreateRow {
  id: TaskId;
  sessionId: SessionId;
  subject: string;
  description: string;
  activeForm?: string;
  createdByTurnId: TurnId;
  createdAt: number;
}

export interface TaskRowPatch {
  subject?: string;
  description?: string;
  activeForm?: string | null;
  status?: TaskRowStatus;
  completedByTurnId?: TurnId | null;
  completedAt?: number | null;
}

export interface TaskMutation {
  id: TaskId;
  sessionId: SessionId;
  expectedVersion: number;
  patch: TaskRowPatch;
  addBlocks: readonly TaskId[];
  addBlockedBy: readonly TaskId[];
  removeBlocks: readonly TaskId[];
  removeBlockedBy: readonly TaskId[];
  updatedAt: number;
}

export type TaskMutationFailure =
  | 'not_found'
  | 'version_conflict'
  | 'blocked'
  | 'active_agent_run'
  | 'dependency_not_found'
  | 'dependency_cycle';

export type TaskMutationResult =
  | { ok: true; changed: boolean; row: TaskRow }
  | { ok: false; reason: TaskMutationFailure; current?: TaskRow; taskId?: TaskId };

export type TaskDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'version_conflict' | 'active_agent_run'; current?: TaskRow };

interface TaskBaseRow extends Omit<TaskRow, 'active_agent_run_id'> {}

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

  findById(id: TaskId, sessionId: SessionId): TaskRow | undefined {
    return this.db.prepare(
      `${TASK_SELECT}
        WHERE task.id = ? AND task.session_id = ?`,
    ).get(id, sessionId) as TaskRow | undefined;
  }

  listForSession(sessionId: SessionId): TaskRow[] {
    return this.db.prepare(
      `${TASK_SELECT}
        WHERE task.session_id = ?
        ORDER BY task.display_number ASC, task.id ASC`,
    ).all(sessionId) as TaskRow[];
  }

  listDependencies(sessionId: SessionId): TaskDependencyRow[] {
    return this.db.prepare(
      `SELECT session_id, blocker_task_id, blocked_task_id, created_at
         FROM task_dependencies
        WHERE session_id = ?
        ORDER BY blocker_task_id ASC, blocked_task_id ASC`,
    ).all(sessionId) as TaskDependencyRow[];
  }

  /** 只查指定任务集合参与的依赖边；单行读取走这里,避免全表扫描。 */
  listDependenciesFor(
    sessionId: SessionId,
    taskIds: readonly TaskId[],
  ): TaskDependencyRow[] {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT session_id, blocker_task_id, blocked_task_id, created_at
         FROM task_dependencies
        WHERE session_id = ?
          AND (blocker_task_id IN (${placeholders})
            OR blocked_task_id IN (${placeholders}))
        ORDER BY blocker_task_id ASC, blocked_task_id ASC`,
    ).all(sessionId, ...taskIds, ...taskIds) as TaskDependencyRow[];
  }

  mutate(input: TaskMutation): TaskMutationResult {
    return this.db.transaction(() => {
      const current = this.findById(input.id, input.sessionId);
      if (!current) return { ok: false, reason: 'not_found' } as const;
      if (current.version !== input.expectedVersion) {
        return { ok: false, reason: 'version_conflict', current } as const;
      }

      if (
        input.patch.status === 'completed'
        || input.patch.status === 'cancelled'
      ) {
        if (current.active_agent_run_id !== null) {
          return { ok: false, reason: 'active_agent_run', current } as const;
        }
      }

      const additions = dependencyAdditions(input);
      const removals = dependencyRemovals(input);
      for (const edge of additions) {
        const blocker = edge.blockerId === input.id
          ? current
          : this.findById(edge.blockerId, input.sessionId);
        const blocked = edge.blockedId === input.id
          ? current
          : this.findById(edge.blockedId, input.sessionId);
        const missingTaskId = blocker ? (blocked ? undefined : edge.blockedId) : edge.blockerId;
        if (missingTaskId !== undefined) {
          return {
            ok: false,
            reason: 'dependency_not_found',
            current,
            taskId: missingTaskId,
          } as const;
        }
        if (
          edge.blockerId === edge.blockedId
          || this.wouldCreateCycle(edge.blockerId, edge.blockedId)
        ) {
          return {
            ok: false,
            reason: 'dependency_cycle',
            current,
            taskId: edge.blockerId === input.id ? edge.blockedId : edge.blockerId,
          } as const;
        }
        const blockedStatus = edge.blockedId === input.id
          ? input.patch.status ?? current.status
          : blocked!.status;
        const blockerStatus = edge.blockerId === input.id
          ? input.patch.status ?? current.status
          : blocker!.status;
        if (
          blockerStatus !== 'completed'
          && (blockedStatus === 'in_progress' || blockedStatus === 'completed')
        ) {
          return {
            ok: false,
            reason: 'blocked',
            current,
            taskId: edge.blockerId,
          } as const;
        }
      }
      if (
        (
          input.patch.status === 'in_progress'
          || input.patch.status === 'completed'
        )
        && this.hasUnresolvedBlockerAfterMutation(
          input,
          additions,
          removals,
        )
      ) {
        return { ok: false, reason: 'blocked', current } as const;
      }

      let dependencyChanged = false;
      for (const edge of removals) {
        const result = this.db.prepare(
          `DELETE FROM task_dependencies
            WHERE session_id = ?
              AND blocker_task_id = ?
              AND blocked_task_id = ?`,
        ).run(input.sessionId, edge.blockerId, edge.blockedId);
        dependencyChanged = dependencyChanged || result.changes > 0;
      }
      for (const edge of additions) {
        const result = this.db.prepare(
          `INSERT OR IGNORE INTO task_dependencies (
             session_id, blocker_task_id, blocked_task_id, created_at
           ) VALUES (?, ?, ?, ?)`,
        ).run(input.sessionId, edge.blockerId, edge.blockedId, input.updatedAt);
        dependencyChanged = dependencyChanged || result.changes > 0;
      }

      const basicChanged = patchChangesRow(current, input.patch);
      if (!basicChanged && !dependencyChanged) {
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
    id: TaskId,
    sessionId: SessionId,
    expectedVersion: number,
  ): TaskDeleteResult {
    return this.db.transaction(() => {
      const current = this.findById(id, sessionId);
      if (!current) return { ok: false, reason: 'not_found' } as const;
      if (current.version !== expectedVersion) {
        return { ok: false, reason: 'version_conflict', current } as const;
      }
      if (current.active_agent_run_id !== null) {
        return { ok: false, reason: 'active_agent_run', current } as const;
      }
      const result = this.db.prepare(
        'DELETE FROM tasks WHERE id = ? AND session_id = ? AND version = ?',
      ).run(id, sessionId, expectedVersion);
      return result.changes === 1
        ? { ok: true } as const
        : { ok: false, reason: 'version_conflict', current: this.findById(id, sessionId) } as const;
    })();
  }

  shouldRemind(
    sessionId: SessionId,
    minimumTurns: number,
    now: number,
  ): boolean {
    return this.db.transaction(() => {
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
      if (turnCount < minimumTurns) return false;

      this.db.prepare(
        `INSERT INTO task_context_state (session_id, last_reminded_at)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_reminded_at = excluded.last_reminded_at`,
      ).run(sessionId, now);
      return true;
    })();
  }

  private hasUnresolvedBlockerAfterMutation(
    input: TaskMutation,
    additions: readonly DependencyEdge[],
    removals: readonly DependencyEdge[],
  ): boolean {
    const blockerIds = new Set(
      this.db.prepare(
        `SELECT blocker_task_id
           FROM task_dependencies
          WHERE session_id = ? AND blocked_task_id = ?`,
      ).pluck().all(input.sessionId, input.id) as TaskId[],
    );
    for (const edge of removals) {
      if (edge.blockedId === input.id) blockerIds.delete(edge.blockerId);
    }
    for (const edge of additions) {
      if (edge.blockedId === input.id) blockerIds.add(edge.blockerId);
    }
    for (const blockerId of blockerIds) {
      const blocker = this.findById(blockerId, input.sessionId);
      if (blocker && blocker.status !== 'completed') return true;
    }
    return false;
  }

  private wouldCreateCycle(blockerId: TaskId, blockedId: TaskId): boolean {
    return this.db.prepare(
      `WITH RECURSIVE downstream(task_id) AS (
         SELECT blocked_task_id
           FROM task_dependencies
          WHERE blocker_task_id = ?
         UNION
         SELECT dependency.blocked_task_id
           FROM task_dependencies dependency
           JOIN downstream current
             ON dependency.blocker_task_id = current.task_id
       )
       SELECT EXISTS (
         SELECT 1 FROM downstream WHERE task_id = ?
       )`,
    ).pluck().get(blockedId, blockerId) === 1;
  }
}

interface DependencyEdge {
  blockerId: TaskId;
  blockedId: TaskId;
}

function dependencyAdditions(input: TaskMutation): DependencyEdge[] {
  return uniqueEdges([
    ...input.addBlocks.map((blockedId) => ({ blockerId: input.id, blockedId })),
    ...input.addBlockedBy.map((blockerId) => ({ blockerId, blockedId: input.id })),
  ]);
}

function dependencyRemovals(input: TaskMutation): DependencyEdge[] {
  return uniqueEdges([
    ...input.removeBlocks.map((blockedId) => ({ blockerId: input.id, blockedId })),
    ...input.removeBlockedBy.map((blockerId) => ({ blockerId, blockedId: input.id })),
  ]);
}

function uniqueEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.blockerId}\0${edge.blockedId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function mergedRow(current: TaskRow, patch: TaskRowPatch): TaskBaseRow {
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

const TASK_SELECT = `
  SELECT task.*,
         (
           SELECT run.id
             FROM agent_runs run
            WHERE run.task_id = task.id
              AND run.status = 'running'
            ORDER BY run.created_at DESC, run.id DESC
            LIMIT 1
         ) AS active_agent_run_id
    FROM tasks task`;
