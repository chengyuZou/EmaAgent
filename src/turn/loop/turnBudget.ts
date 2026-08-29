// Turn 级并发坑位：agent AgentBudget 接口的本包实现；根 Agent 与全部子 Agent 共用。
import type { AgentBudget } from '@ema-agent/agent';
import { TurnBudgetExceededError } from '../errors.js';

export interface TurnBudgetLimits {
  readonly maxConcurrentSubagents: number;
}

/**
 * 并发坑位随 Turn 创建、随终态销毁。enterSubagent 返回的释放函数幂等，
 * 子 Agent 结束时调用一次归还坑位。
 */
export class TurnBudget implements AgentBudget {
  private activeSubagents = 0;

  constructor(private readonly limits: TurnBudgetLimits) {}

  enterSubagent(): () => void {
    if (this.activeSubagents >= this.limits.maxConcurrentSubagents) {
      throw new TurnBudgetExceededError(
        `并发子 Agent 超过预算 ${this.limits.maxConcurrentSubagents}`,
      );
    }
    this.activeSubagents += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSubagents -= 1;
    };
  }
}
