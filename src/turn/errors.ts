import type { TurnFailureCode, TurnFailurePhase } from '@ema-agent/turn-terms';

export type { TurnFailureCode, TurnFailurePhase };

/** 业务层发现跨 Session 引用 Turn 时抛出的稳定错误。 */
export class TurnOwnershipError extends Error {
  readonly code = 'turn_ownership_violation' as const;

  constructor(message: string) {
    super(`turn_ownership_violation: ${message}`);
    this.name = 'TurnOwnershipError';
  }
}

/** 同一 Session 已有活动根 Turn 时又注册一个，抛出的进程内不变量错误。 */
export class ActiveTurnAlreadyRegisteredError extends Error {
  readonly code = 'active_turn_already_registered' as const;

  constructor(sessionId: string) {
    super(`active_turn_already_registered: ${sessionId}`);
    this.name = 'ActiveTurnAlreadyRegisteredError';
  }
}

/** 输入准备阶段已完成领域错误映射，TurnExecutor 只负责提交统一失败终态。 */
export class TurnPreparationError extends Error {
  constructor(
    readonly code: TurnFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TurnPreparationError';
  }
}
