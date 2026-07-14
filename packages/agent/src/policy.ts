import type { BuiltTool } from '@ema-agent/tools';
import type { LlmToolDef } from '@ema-agent/llm';

// ── AgentPolicy ───────────────────────────────────────────────────────────────

export class AgentPolicy {
  private readonly allowed:      BuiltTool[];
  private readonly allowedNames: Set<string>;

  constructor(
    allTools: BuiltTool[],
    private readonly maxIter = 30,
  ) {
    // Provider KV Cache 对工具定义顺序敏感；使用跨平台一致的 UTF-16 code-unit 顺序。
    this.allowed      = [...allTools].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    this.allowedNames = new Set(allTools.map(t => t.name));
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
    return this.allowedNames.has(toolName);
  }

  maxIterations(): number {
    return this.maxIter;
  }
}
