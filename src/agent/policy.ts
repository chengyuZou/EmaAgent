// 把一次 Turn 的工具池转换成模型工具定义和执行准入判断。
import type { ToolPool } from '@ema-agent/tools';

// ── TurnPolicy ────────────────────────────────────────────────────────────────

export class TurnPolicy {
  constructor(
    private readonly pool: ToolPool,
    private readonly maxIter = 30,
  ) {}

  /** Returns true if the named tool is permitted under this policy. */
  allows(toolName: string): boolean {
    return this.pool.get(toolName) !== undefined;
  }

  /**
   * 子 Agent 在真正 spawn 时读取当前上限；返回副本，调用方不能改写父作用域。
   */
  allowedIds(): ReadonlySet<string> {
    return new Set(this.pool.tools.map((tool) => tool.id));
  }

  /** 每轮开始时取得当前能力上限；同一实例必须同时交给 Context 和执行器。 */
  toolPool(): ToolPool {
    return this.pool;
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
