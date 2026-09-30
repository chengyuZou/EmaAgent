import type { Goal } from './types.js';

export type GoalErrorCode =
  | 'session_not_found'
  | 'goal_not_found'
  | 'goal_version_conflict'
  | 'goal_status_conflict'
  | 'goal_already_exists'
  | 'goal_plan_conflict'
  | 'goal_objective_empty'
  | 'goal_feedback_empty'
  | 'goal_error_empty';

export class GoalError extends Error {
  constructor(
    readonly code: GoalErrorCode,
    readonly current: Goal | null = null,
  ) {
    super(code);
    this.name = 'GoalError';
  }
}
