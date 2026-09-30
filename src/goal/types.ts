import type { GoalReasonRow, GoalStatusRow } from '@ema-agent/storage';

export type GoalStatus = GoalStatusRow;
export type GoalReason = GoalReasonRow;

export interface Goal {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  /** 工作模型最近一次进度说明, 不作为完成判定或激活授权. */
  readonly feedback: string | null;
  readonly status: GoalStatus;
  readonly version: number;
  readonly reason: GoalReason | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

/** 设置 Data 页的历史列表行, 进度和失败详情按 Goal 身份另行读取. */
export type GoalSummary = Pick<Goal,
  'id' | 'sessionId' | 'objective' | 'status' | 'reason' | 'createdAt' | 'updatedAt' | 'completedAt'
>;

/** 每次修改指定目标及读取时的版本, 不按 Session 把迟到请求改写到后继目标. */
export interface GoalIdentity {
  readonly sessionId: string;
  readonly goalId: string;
  readonly expectedVersion: number;
}
