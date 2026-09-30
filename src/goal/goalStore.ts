import { randomUUID } from 'node:crypto';
import { GoalsRepo, SessionsRepo, type Database, type GoalRow } from '@ema-agent/storage';
import type { GoalEvent } from './events.js';
import type { Goal, GoalSummary, GoalIdentity, GoalReason } from './types.js';
import { GoalError } from './error.js';

export class GoalStore {
  private readonly repo: GoalsRepo;
  private readonly sessions: SessionsRepo;

  constructor(
    private readonly db: Database,
    /** 已提交的目标变化, 由装配层接到应用事件和后续工作选择. */
    private readonly emit?: (event: GoalEvent) => void,
  ) {
    this.repo = new GoalsRepo(db.sqlite);
    this.sessions = new SessionsRepo(db.sqlite);
  }

  create(sessionId: string, objective: string): Goal {
    const text = this.objectiveText(objective);
    const goal = this.db.sqlite.transaction(() => {
      this.requireNonPlanSession(sessionId);
      const current = this.getCurrent(sessionId);
      if (current) throw new GoalError('goal_already_exists', current);
      const now = Date.now();
      const created: Goal = {
        id: randomUUID(),
        sessionId,
        objective: text,
        feedback: null,
        status: 'active',
        version: 1,
        reason: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      this.repo.insert(this.toRow(created));
      return created;
    }).immediate();
    this.emit?.({ type: 'goal_created', goal });
    return goal;
  }

  get(sessionId: string, goalId: string): Goal | null {
    const row = this.repo.findById(sessionId, goalId);
    return row ? this.fromRow(row) : null;
  }

  getCurrent(sessionId: string): Goal | null {
    const row = this.repo.findCurrent(sessionId);
    return row ? this.fromRow(row) : null;
  }

  listSummaries(sessionId: string): GoalSummary[] {
    return this.repo.listSummariesForSession(sessionId).map(row => ({
      id: row.id,
      sessionId: row.session_id,
      objective: row.objective,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }));
  }

  edit(identity: GoalIdentity, objective: string): Goal {
    const text = this.objectiveText(objective);
    return this.mutate(identity, 'goal_updated', goal => {
      this.requireUnfinished(goal);
      if (goal.objective === text) return goal;
      return { ...goal, objective: text, feedback: null };
    });
  }

  reportFeedback(identity: GoalIdentity, feedback: string): Goal {
    const text = feedback.trim();
    if (!text) throw new GoalError('goal_feedback_empty');
    return this.mutate(identity, 'goal_updated', goal => {
      this.requireActive(goal);
      if (goal.feedback === text) return goal;
      return { ...goal, feedback: text };
    });
  }

  pause(identity: GoalIdentity): Goal {
    return this.mutate(identity, 'goal_paused', goal => {
      this.requireUnfinished(goal);
      if (goal.status === 'paused') return goal;
      return { ...goal, status: 'paused' };
    });
  }

  activate(identity: GoalIdentity): Goal {
    return this.mutate(identity, 'goal_activated', goal => {
      this.requireUnfinished(goal);
      this.requireNonPlanSession(goal.sessionId);
      if (goal.status === 'active') return goal;
      return { ...goal, status: 'active' };
    });
  }

  complete(identity: GoalIdentity, feedback: string): Goal {
    const text = this.feedbackText(feedback);
    return this.mutate(identity, 'goal_completed', goal => {
      this.requireActive(goal);
      return { ...this.completedGoal(goal, 'succeeded', null), feedback: text };
    });
  }

  fail(identity: GoalIdentity, feedback: string, error: string): Goal {
    const text = this.feedbackText(feedback);
    const detail = error.trim();
    if (!detail) throw new GoalError('goal_error_empty');
    return this.mutate(identity, 'goal_failed', goal => {
      this.requireActive(goal);
      return { ...this.completedGoal(goal, 'failed', detail), feedback: text };
    });
  }

  cancel(identity: GoalIdentity): Goal {
    return this.mutate(identity, 'goal_cancelled', goal => {
      this.requireUnfinished(goal);
      return this.completedGoal(goal, 'cancelled', null);
    });
  }

  delete(identity: GoalIdentity): void {
    this.db.sqlite.transaction(() => {
      this.requireIdentity(identity);
      this.repo.delete(identity.sessionId, identity.goalId);
    }).immediate();
    this.emit?.({
      type: 'goal_deleted',
      sessionId: identity.sessionId,
      goalId: identity.goalId,
    });
  }

  /** ready 前暂停旧进程的 active 目标, 保留身份和历史, 不启动工作. */
  pauseActiveOnStartup(): void {
    const paused = this.db.sqlite.transaction(() => {
      const now = Date.now();
      return this.repo.listActive().map(row => {
        const goal: Goal = {
          ...this.fromRow(row),
          status: 'paused',
          version: row.version + 1,
          updatedAt: now,
        };
        this.repo.update(this.toRow(goal));
        return goal;
      });
    }).immediate();
    for (const goal of paused) this.emit?.({ type: 'goal_paused', goal });
  }

  private mutate(
    identity: GoalIdentity,
    type: Exclude<GoalEvent['type'], 'goal_deleted' | 'goal_created'>,
    change: (goal: Goal) => Goal,
  ): Goal {
    // 检查身份与写入之间不 await, 写锁覆盖整个修改, 事件在事务提交后发出.
    const result = this.db.sqlite.transaction(() => {
      const current = this.requireIdentity(identity);
      const next = change(current);
      if (next === current) return { goal: current, changed: false };
      const goal = { ...next, version: current.version + 1, updatedAt: Date.now() };
      this.repo.update(this.toRow(goal));
      return { goal, changed: true };
    }).immediate();
    if (result.changed) this.emit?.({ type, goal: result.goal });
    return result.goal;
  }

  private requireIdentity(identity: GoalIdentity): Goal {
    const goal = this.get(identity.sessionId, identity.goalId);
    if (!goal) throw new GoalError('goal_not_found', this.getCurrent(identity.sessionId));
    if (goal.version !== identity.expectedVersion) {
      throw new GoalError('goal_version_conflict', goal);
    }
    return goal;
  }

  private requireNonPlanSession(sessionId: string): void {
    const session = this.sessions.findById(sessionId);
    if (!session) throw new GoalError('session_not_found');
    if (session.permission_mode === 'plan') throw new GoalError('goal_plan_conflict');
  }

  private requireUnfinished(goal: Goal): void {
    if (goal.status === 'completed') throw new GoalError('goal_status_conflict', goal);
  }

  private requireActive(goal: Goal): void {
    if (goal.status !== 'active') throw new GoalError('goal_status_conflict', goal);
  }

  private completedGoal(goal: Goal, reason: GoalReason, error: string | null): Goal {
    return { ...goal, status: 'completed', reason, error, completedAt: Date.now() };
  }

  private objectiveText(objective: string): string {
    if (!objective.trim()) throw new GoalError('goal_objective_empty');
    return objective;
  }

  private feedbackText(feedback: string): string {
    const text = feedback.trim();
    if (!text) throw new GoalError('goal_feedback_empty');
    return text;
  }

  private fromRow(row: GoalRow): Goal {
    return {
      id: row.id,
      sessionId: row.session_id,
      objective: row.objective,
      feedback: row.feedback,
      status: row.status,
      version: row.version,
      reason: row.reason,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  private toRow(goal: Goal): GoalRow {
    return {
      id: goal.id,
      session_id: goal.sessionId,
      objective: goal.objective,
      feedback: goal.feedback,
      status: goal.status,
      version: goal.version,
      reason: goal.reason,
      error: goal.error,
      created_at: goal.createdAt,
      updated_at: goal.updatedAt,
      completed_at: goal.completedAt,
    };
  }
}
