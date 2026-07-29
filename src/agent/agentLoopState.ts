// 保存单次 Agent 执行循环的不可变状态，明确每次继续或结束的原因。

import type { LlmTokenUsage } from '@ema-agent/llm';

export type AgentLoopPhase =
  | 'preprocessing'
  | 'thinking'
  | 'acting'
  | 'waiting_user'
  | 'done'
  | 'aborted';

// 每次转换都保留继续原因，供熔断器识别重复失败。
export type AgentLoopTransition =
  | 'initial'
  | 'next_turn'                    // 工具轮次结束后继续
  | 'no_tool_calls'                // 模型只返回最终内容
  | 'user_abort'
  | 'max_iterations'
  | 'hook_abort'
  | 'permission_denial_loop'
  | 'waiting_user'
  | 'user_answered'
  | 'max_output_tokens_recovery'   // 输出截断后只允许续写一次
  | 'reactive_compact';            // 上下文超限后压缩并重试

export interface AgentLoopState {
  readonly phase:      AgentLoopPhase;
  readonly iteration:  number;
  readonly transition: AgentLoopTransition;
  readonly usage:      LlmTokenUsage;
  /** 0 表示尚未续写；1 表示已续写一次，再次截断时必须结束。 */
  readonly maxOutputTokensRecoveryCount: number;
  /** 当前迭代是否已经执行过一次响应式压缩。 */
  readonly hasAttemptedReactiveCompact: boolean;
}

// ── 初始状态与转换 ───────────────────────────────────────────────────────────

export function createAgentLoopState(): AgentLoopState {
  return Object.freeze({
    phase:                       'preprocessing',
    iteration:                   0,
    transition:                  'initial',
    usage:                       { inputTokens: 0, outputTokens: 0 },
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  });
}

/** 返回新的冻结状态，并强制调用方写明状态转换原因。 */
export function advanceAgentLoopState(
  state: AgentLoopState,
  update: {
    phase: AgentLoopPhase;
    transition: AgentLoopTransition;
  } & Partial<Omit<AgentLoopState, 'phase' | 'transition'>>,
): AgentLoopState {
  return Object.freeze({ ...state, ...update });
}

export function addUsage(
  state:  AgentLoopState,
  delta:  LlmTokenUsage,
): AgentLoopState {
  const cacheReadInputTokens = sumOptional(
    state.usage.cacheReadInputTokens,
    delta.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = sumOptional(
    state.usage.cacheWriteInputTokens,
    delta.cacheWriteInputTokens,
  );
  return Object.freeze({
    ...state,
    usage: {
      inputTokens:  state.usage.inputTokens  + delta.inputTokens,
      outputTokens: state.usage.outputTokens + delta.outputTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    },
  });
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}
