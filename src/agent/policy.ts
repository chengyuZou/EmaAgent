// 把一次 Turn 的工具能力作用域转换成模型工具定义和执行准入判断。
import type {
  ToolCapabilityScope,
  ToolPool,
} from '@ema-agent/tools';
import { AgentToolCapabilityScope } from './tool-capability-scope.js';

// ── TurnPolicy ────────────────────────────────────────────────────────────────

export class TurnPolicy {
  private readonly scope: AgentToolCapabilityScope;

  constructor(
    toolPool: ToolPool,
    private readonly maxIter = 30,
  ) {
    this.scope = new AgentToolCapabilityScope(toolPool);
  }

  /** Returns true if the named tool is permitted under this policy. */
  allows(toolName: string): boolean {
    return this.scope.allows(toolName);
  }

  /** 交给 BuiltinToolContext.toolCapabilities，使 Skill 和未来运行模式只能收窄能力。 */
  capabilities(): ToolCapabilityScope {
    return this.scope;
  }

  /**
   * 子 Agent 在真正 spawn 时读取当前上限；返回副本，调用方不能改写父作用域。
   * Skill 若已收窄当前 Agent，这里会立即反映收窄后的稳定工具 ID。
   */
  allowedIds(): ReadonlySet<string> {
    return new Set(this.scope.list().map((tool) => tool.id));
  }

  /** 每轮开始时取得当前能力上限；同一实例必须同时交给 Context 和执行器。 */
  toolPool(): ToolPool {
    return this.scope.pool();
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
