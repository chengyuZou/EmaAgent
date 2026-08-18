// 测试 TurnBudget 的时长/输出/工具/子 Agent 四类额度与并发坑位归还。
import { describe, expect, it } from 'vitest';
import { TurnBudgetExceededError } from '../errors.js';
import { TurnBudget } from '../loop/turnBudget.js';

function makeBudget(overrides: Partial<Parameters<typeof TurnBudget.prototype.constructor>[0]> = {}) {
  return new TurnBudget({
    maxDurationMs: 60_000,
    maxOutputTokens: 100,
    maxToolCalls: 2,
    maxSubagents: 2,
    maxConcurrentSubagents: 1,
    ...overrides,
  });
}

describe('TurnBudget', () => {
  it('输出 Token 累计到上限后 assertWithinLimits 抛出；remaining 同步递减', () => {
    const budget = makeBudget();
    expect(budget.remainingOutputTokens()).toBe(100);
    budget.recordUsage({ inputTokens: 10, outputTokens: 40 });
    expect(budget.remainingOutputTokens()).toBe(60);
    budget.recordUsage({ inputTokens: 10, outputTokens: 60 });
    expect(budget.remainingOutputTokens()).toBe(0);
    expect(() => budget.assertWithinLimits()).toThrow(TurnBudgetExceededError);
  });

  it('工具调用次数超过预算即抛', () => {
    const budget = makeBudget();
    budget.reserveToolCall();
    budget.reserveToolCall();
    expect(() => budget.reserveToolCall()).toThrow(/Tool 调用次数/);
  });

  it('子 Agent 总数与并发双上限；释放函数幂等归还坑位', () => {
    const budget = makeBudget();
    const release = budget.enterSubagent();
    expect(() => budget.enterSubagent()).toThrow(/并发子 Agent/);
    release();
    release();
    const second = budget.enterSubagent();
    second();
    expect(() => budget.enterSubagent()).toThrow(/子 Agent 总数/);
  });

  it('运行时长超预算即抛', () => {
    const budget = makeBudget({ maxDurationMs: -1 });
    expect(() => budget.assertWithinLimits()).toThrow(/运行时长/);
  });
});
