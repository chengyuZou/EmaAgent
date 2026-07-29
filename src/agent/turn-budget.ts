// 统一限制一个 Agent Turn 及其全部 Subagent 的时间、Token 和并发资源。

import type { LlmTokenUsage } from '@ema-agent/llm';

export interface TurnBudgetLimits {
  maxWallTimeMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxSubagents: number;
  maxConcurrentSubagents: number;
}

export const DEFAULT_TURN_BUDGET_LIMITS: Readonly<TurnBudgetLimits> = Object.freeze({
  maxWallTimeMs: 60 * 60 * 1000,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 256_000,
  maxToolCalls: 256,
  maxSubagents: 16,
  maxConcurrentSubagents: 4,
});

export type TurnBudgetDimension =
  | 'wall_time'
  | 'input_tokens'
  | 'output_tokens'
  | 'tool_calls'
  | 'subagents'
  | 'concurrent_subagents';

export class AgentBudgetExceededError extends Error {
  readonly code = 'turn/budget_exceeded' as const;

  constructor(
    readonly dimension: TurnBudgetDimension,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Agent turn budget exceeded: ${dimension} ${used}/${limit}`);
    this.name = 'AgentBudgetExceededError';
  }
}

/**
 * 单线程事件循环内的同步计数器不需要锁；所有资源在执行前预留，失败时立即抛出，
 * 防止“先调用 Provider/工具，再发现已经超预算”。
 */
export class TurnBudget {
  private readonly startedAt = Date.now();
  private inputTokens = 0;
  private outputTokens = 0;
  private toolCalls = 0;
  private subagents = 0;
  private concurrentSubagents = 0;

  constructor(
    private readonly limits: Readonly<TurnBudgetLimits> = DEFAULT_TURN_BUDGET_LIMITS,
  ) {
    validateLimits(limits);
  }

  assertWithinLimits(now = Date.now()): void {
    const elapsed = Math.max(0, now - this.startedAt);
    if (elapsed > this.limits.maxWallTimeMs) {
      throw new AgentBudgetExceededError('wall_time', elapsed, this.limits.maxWallTimeMs);
    }
  }

  /** 返回下一次模型调用可使用的输出额度；额度耗尽时在请求 Provider 前终止。 */
  remainingOutputTokens(): number {
    const remaining = this.limits.maxOutputTokens - this.outputTokens;
    if (remaining <= 0) {
      throw new AgentBudgetExceededError(
        'output_tokens',
        this.outputTokens + 1,
        this.limits.maxOutputTokens,
      );
    }
    return remaining;
  }

  recordUsage(usage: LlmTokenUsage): void {
    this.assertWithinLimits();
    const input = finiteNonNegative('input_tokens', usage.inputTokens);
    const output = finiteNonNegative('output_tokens', usage.outputTokens);
    const nextInput = this.inputTokens + input;
    const nextOutput = this.outputTokens + output;
    if (nextInput > this.limits.maxInputTokens) {
      throw new AgentBudgetExceededError('input_tokens', nextInput, this.limits.maxInputTokens);
    }
    if (nextOutput > this.limits.maxOutputTokens) {
      throw new AgentBudgetExceededError('output_tokens', nextOutput, this.limits.maxOutputTokens);
    }
    this.inputTokens = nextInput;
    this.outputTokens = nextOutput;
  }

  reserveToolCall(): void {
    this.assertWithinLimits();
    const next = this.toolCalls + 1;
    if (next > this.limits.maxToolCalls) {
      throw new AgentBudgetExceededError('tool_calls', next, this.limits.maxToolCalls);
    }
    this.toolCalls = next;
  }

  enterSubagent(): () => void {
    this.assertWithinLimits();
    const nextTotal = this.subagents + 1;
    if (nextTotal > this.limits.maxSubagents) {
      throw new AgentBudgetExceededError('subagents', nextTotal, this.limits.maxSubagents);
    }
    const nextConcurrent = this.concurrentSubagents + 1;
    if (nextConcurrent > this.limits.maxConcurrentSubagents) {
      throw new AgentBudgetExceededError(
        'concurrent_subagents',
        nextConcurrent,
        this.limits.maxConcurrentSubagents,
      );
    }

    this.subagents = nextTotal;
    this.concurrentSubagents = nextConcurrent;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.concurrentSubagents = Math.max(0, this.concurrentSubagents - 1);
    };
  }
}

function finiteNonNegative(
  dimension: 'input_tokens' | 'output_tokens',
  value: number,
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentBudgetExceededError(dimension, value, 0);
  }
  return value;
}

function validateLimits(limits: Readonly<TurnBudgetLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid TurnBudget limit ${name}: ${value}`);
    }
  }
}
