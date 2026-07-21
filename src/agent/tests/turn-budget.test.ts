// 测试主 Agent 与 Subagent 共用预算的 Token、工具、并发和配置校验。

import { describe, expect, it } from 'vitest';
import { AgentBudgetExceededError, TurnBudget, type TurnBudgetLimits } from '../turn-budget.js';

const LIMITS: TurnBudgetLimits = {
  maxWallTimeMs: 60_000,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  maxToolCalls: 2,
  maxSubagents: 2,
  maxConcurrentSubagents: 1,
};

describe('TurnBudget', () => {
  it('累计主 Agent 与子 Agent 用量，超限前拒绝下一项资源', () => {
    const budget = new TurnBudget(LIMITS);
    budget.recordUsage({ inputTokens: 60, outputTokens: 20 });
    budget.recordUsage({ inputTokens: 40, outputTokens: 30 });

    expect(() => budget.recordUsage({ inputTokens: 1, outputTokens: 0 }))
      .toThrowError(expect.objectContaining({
        code: 'turn/budget_exceeded',
        dimension: 'input_tokens',
      }));

    budget.reserveToolCall();
    budget.reserveToolCall();
    expect(() => budget.reserveToolCall()).toThrow(AgentBudgetExceededError);
  });

  it('Subagent 并发槽释放后可复用，但总创建数仍单调计数', () => {
    const budget = new TurnBudget(LIMITS);
    const releaseFirst = budget.enterSubagent();
    expect(() => budget.enterSubagent()).toThrowError(expect.objectContaining({
      dimension: 'concurrent_subagents',
    }));

    releaseFirst();
    const releaseSecond = budget.enterSubagent();
    releaseSecond();
    expect(() => budget.enterSubagent()).toThrowError(expect.objectContaining({
      dimension: 'subagents',
    }));
  });

  it('拒绝 Infinity、零和负数配置，不允许失控预算进入运行时', () => {
    expect(() => new TurnBudget({ ...LIMITS, maxToolCalls: Number.POSITIVE_INFINITY }))
      .toThrow(TypeError);
    expect(() => new TurnBudget({ ...LIMITS, maxSubagents: 0 }))
      .toThrow(TypeError);
  });
});
