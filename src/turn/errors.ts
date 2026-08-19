import type { TurnFailureCode, TurnFailurePhase } from '@ema-agent/turn-terms';
import { llmProviderErrorCode } from '@ema-agent/llm';

export type { TurnFailureCode, TurnFailurePhase };

/** 业务层发现跨 Session 引用 Turn 时抛出的稳定错误。 */
export class TurnOwnershipError extends Error {
  readonly code = 'turn_ownership_violation' as const;

  constructor(message: string) {
    super(`turn_ownership_violation: ${message}`);
    this.name = 'TurnOwnershipError';
  }
}

/** 同一 Session 已有活动根 Turn 时拒绝开新 Turn；路由层映射为 409。 */
export class SessionBusyError extends Error {
  readonly code = 'session_busy' as const;

  constructor(sessionId: string) {
    super(`session_busy: a turn is already running for session ${sessionId}`);
    this.name = 'SessionBusyError';
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

/** 根 Agent 或子 Agent 申请额度时预算已耗尽；turn.ts 映射为 turn/budget_exceeded 失败终态。 */
export class TurnBudgetExceededError extends Error {
  readonly code = 'turn/budget_exceeded' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TurnBudgetExceededError';
  }
}

// ── 失败终态的错误码映射 ─────────────────────────────────────────────────────

const PROVIDER_FAILURE_CODES: ReadonlySet<string> = new Set([
  'auth/api_key_invalid',
  'provider/context_too_long',
  'provider/model_capability_unsupported',
  'provider/server_error',
  'provider/tool_arguments_invalid_json',
  'provider/not_configured',
]);

/** 任意异常 → Turn 失败终态错误码：准备错误用自身 code，预算错误固定码，llm 码查表，其余归执行失败。 */
export function failureCodeOf(error: unknown): TurnFailureCode {
  if (error instanceof TurnPreparationError) return error.code;
  if (error instanceof TurnBudgetExceededError) return 'turn/budget_exceeded';
  const code: string = llmProviderErrorCode(error);
  // llm 错误码并集比 TurnFailureCode 宽；不在 Turn 失败词表的归为执行失败。
  return PROVIDER_FAILURE_CODES.has(code) ? code as TurnFailureCode : 'turn/execution_failed';
}

/** 任意异常 → 面向用户的失败消息。 */
export function failureMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
