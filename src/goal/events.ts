import type { Goal } from './types.js';

// 只在 SQL 提交后发事件. 删除没有完整记录, 仍明确指出被删除的目标身份.
export type GoalEvent =
  | {
    readonly type:
      | 'goal_created'
      | 'goal_updated'
      | 'goal_paused'
      | 'goal_activated'
      | 'goal_completed'
      | 'goal_failed'
      | 'goal_cancelled';
    readonly goal: Goal;
  }
  | {
    readonly type: 'goal_deleted';
    readonly sessionId: string;
    readonly goalId: string;
  };
