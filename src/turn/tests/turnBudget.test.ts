// 测试 TurnBudget 的并发子 Agent 坑位与幂等归还。
import { describe, expect, it } from 'vitest';
import { TurnBudgetExceededError } from '../errors.js';
import { TurnBudget } from '../loop/turnBudget.js';

describe('TurnBudget', () => {
  it('并发坑位超上限即抛；释放函数幂等归还', () => {
    const budget = new TurnBudget({ maxConcurrentSubagents: 1 });
    const release = budget.enterSubagent();
    expect(() => budget.enterSubagent()).toThrow(/并发子 Agent/);
    release();
    release();
    const second = budget.enterSubagent();
    expect(() => budget.enterSubagent()).toThrow(/并发子 Agent/);
    second();
  });
});
