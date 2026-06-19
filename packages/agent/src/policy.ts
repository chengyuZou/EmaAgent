import type { BuiltTool } from '@ema-agent/tool';
import type { LlmToolDef } from '@ema-agent/llm';

// ── AgentPolicy ───────────────────────────────────────────────────────────────

export class AgentPolicy {
  private readonly allowed: BuiltTool[];

  constructor(
    allTools: BuiltTool[],
    private readonly maxIter = 30,
  ) {
    this.allowed = allTools;
  }

  /** LlmToolDef[] ready to pass straight to LlmRequest.tools. */
  toolDefs(): LlmToolDef[] {
    return this.allowed.map((t) => {
      const d = t.descriptor();
      return { name: d.name, description: d.description, parameters: d.inputJsonSchema };
    });
  }

  /** Returns true if the named tool is permitted under this policy. */
  allows(toolName: string): boolean {
    return this.allowed.some((t) => t.name === toolName);
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
