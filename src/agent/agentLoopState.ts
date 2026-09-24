import type { LlmTokenUsage } from '@ema-agent/llm';

export type AgentLoopPhase =
  | 'thinking'
  | 'acting'
  | 'waiting_user'
  | 'completed'
  | 'aborted';

export type AgentLoopStopReason =
  | 'completed'
  | 'aborted'
  | 'max_iterations'
  | 'output_recovery_failed';

export interface AgentLoopState {
  readonly phase: AgentLoopPhase;
  // 当前的迭代次数
  readonly iterations: number;
  /** 当前 AgentLoop 内全部 LLM 调用的 Token 累计用量 */
  readonly usage: LlmTokenUsage;
  readonly stopReason?: AgentLoopStopReason;
}

export function createAgentLoopState(): AgentLoopState {
  return Object.freeze({
    phase: 'thinking',
    iterations: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
}

export function updateAgentLoopState(
  state: AgentLoopState,
  update: Partial<AgentLoopState>,
): AgentLoopState {
  return Object.freeze({ ...state, ...update });
}

export function addAgentUsage(
  state: AgentLoopState,
  delta: LlmTokenUsage,
): AgentLoopState {
  const cacheReadInputTokens = sumOptional(
    state.usage.cacheReadInputTokens,
    delta.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = sumOptional(
    state.usage.cacheWriteInputTokens,
    delta.cacheWriteInputTokens,
  );
  return updateAgentLoopState(state, {
    usage: {
      inputTokens: state.usage.inputTokens + delta.inputTokens,
      outputTokens: state.usage.outputTokens + delta.outputTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    },
  });
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}
