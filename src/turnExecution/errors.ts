import type { TurnFailureCode } from '@ema-agent/turn';

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
