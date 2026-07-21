// 把 Agent 的工具能力作用域转换成模型工具定义和执行准入判断。
import type {
  IToolCapabilityScope,
  ToolManifestSnapshot,
} from '@ema-agent/tools';
import type { LlmToolDef } from '@ema-agent/llm';
import { AgentToolCapabilityScope } from './tool-capability-scope.js';

// ── AgentPolicy ───────────────────────────────────────────────────────────────

export class AgentPolicy {
  private readonly scope: AgentToolCapabilityScope;

  constructor(
    private readonly manifest: ToolManifestSnapshot,
    private readonly maxIter = 30,
  ) {
    this.scope = new AgentToolCapabilityScope(manifest.entries);
  }

  /** LlmToolDef[] ready to pass straight to LlmRequest.tools. */
  toolDefs(): LlmToolDef[] {
    return this.scope.list().map((t) => {
      return {
        name: t.name,
        description: t.description,
        parameters: t.inputJsonSchema as Record<string, unknown>,
      };
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

  manifestSnapshot(): ToolManifestSnapshot {
    return this.manifest;
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
