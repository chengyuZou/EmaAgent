// 这里把 Agent 的工具能力作用域转换成模型工具定义和执行准入判断。
import type { BuiltTool, IToolCapabilityScope } from '@ema-agent/tools';
import type { LlmToolDef } from '@ema-agent/llm';
import { AgentToolCapabilityScope } from './tool-capability-scope.js';

// ── AgentPolicy ───────────────────────────────────────────────────────────────

export class AgentPolicy {
  private readonly scope: AgentToolCapabilityScope;

  constructor(
    allTools: BuiltTool[],
    private readonly maxIter = 30,
  ) {
    this.scope = new AgentToolCapabilityScope(allTools);
  }

  /** LlmToolDef[] ready to pass straight to LlmRequest.tools. */
  toolDefs(): LlmToolDef[] {
    return this.scope.list().map((t) => {
      const d = t.descriptor();
      return { name: d.name, description: d.description, parameters: d.inputJsonSchema };
    });
  }

  /** Returns true if the named tool is permitted under this policy. */
  allows(toolName: string): boolean {
    return this.scope.allows(toolName);
  }

  /** 交给 ToolExecutionContext，使 Skill 和未来运行模式只能收窄能力。 */
  capabilities(): IToolCapabilityScope {
    return this.scope;
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
