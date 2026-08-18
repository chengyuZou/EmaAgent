// Turn 级预算：agent AgentBudget 接口的本包实现；根 Agent 与全部子 Agent 共用同一组额度。
import type { AgentBudget } from '@ema-agent/agent';
import type { LlmTokenUsage } from '@ema-agent/llm';
import { TurnBudgetExceededError } from '../errors.js';

export interface TurnBudgetLimits {
  readonly maxDurationMs: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly maxSubagents: number;
  readonly maxConcurrentSubagents: number;
}

/**
 * 预算对象随 Turn 创建、随终态销毁；额度检查只报真实耗尽，不做"接近上限"的预警。
 * enterSubagent 返回的释放函数幂等，子 Agent 结束时调用一次归还并发坑位。
 */
export class TurnBudget implements AgentBudget {
  private readonly startedAt = Date.now();
  private usedOutputTokens = 0;
  private toolCalls = 0;
  private subagentsEntered = 0;
  private activeSubagents = 0;

  constructor(private readonly limits: TurnBudgetLimits) {}

  assertWithinLimits(): void {
    if (Date.now() - this.startedAt > this.limits.maxDurationMs) {
      throw new TurnBudgetExceededError(
        `Turn 运行时长超过预算 ${this.limits.maxDurationMs}ms`,
      );
    }
    if (this.usedOutputTokens >= this.limits.maxOutputTokens) {
      throw new TurnBudgetExceededError(
        `输出 Token 超过预算 ${this.limits.maxOutputTokens}`,
      );
    }
  }

  remainingOutputTokens(): number {
    return Math.max(0, this.limits.maxOutputTokens - this.usedOutputTokens);
  }

  recordUsage(usage: LlmTokenUsage): void {
    this.usedOutputTokens += usage.outputTokens;
  }

  reserveToolCall(): void {
    this.toolCalls += 1;
    if (this.toolCalls > this.limits.maxToolCalls) {
      throw new TurnBudgetExceededError(
        `Tool 调用次数超过预算 ${this.limits.maxToolCalls}`,
      );
    }
  }

  enterSubagent(): () => void {
    if (this.subagentsEntered >= this.limits.maxSubagents) {
      throw new TurnBudgetExceededError(
        `子 Agent 总数超过预算 ${this.limits.maxSubagents}`,
      );
    }
    if (this.activeSubagents >= this.limits.maxConcurrentSubagents) {
      throw new TurnBudgetExceededError(
        `并发子 Agent 超过预算 ${this.limits.maxConcurrentSubagents}`,
      );
    }
    this.subagentsEntered += 1;
    this.activeSubagents += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeSubagents -= 1;
    };
  }
}
