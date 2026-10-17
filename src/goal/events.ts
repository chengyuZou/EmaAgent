import type { Goal } from './types.js';

/** 事务提交后发布. 删除事件只携带身份, 其他事件携带提交后的完整目标. */
export type GoalEvent =
  | {
    readonly type:
      | 'goal_created'
      | 'goal_edited'
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
