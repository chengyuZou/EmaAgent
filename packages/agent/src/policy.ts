import type { AgentSubMode } from '@ema-agent/contracts';
import type { BuiltTool } from '@ema-agent/tool';
import type { LlmToolDef } from '@ema-agent/llm';

// ── AgentPolicy ───────────────────────────────────────────────────────────────

/**
 * Per-turn tool access policy derived from the agent sub-mode.
 *
 *  plan  — read-only tools only; write/execute calls are permission-denied
 *           before even reaching the tool. Good for "look before you leap".
 *
 *  debug — all tools, but with a tighter iteration budget so the agent is
 *           forced to report progress more frequently.
 *
 *  full  — all tools, maximum iterations. Production-quality autonomous runs.
 */
export class AgentPolicy {
  private readonly allowed: BuiltTool[];

  constructor(
    private readonly subMode: AgentSubMode,
    allTools: BuiltTool[],
  ) {
    // plan: only tools that declare themselves read-only
    this.allowed = subMode === 'plan'
      ? allTools.filter((t) => t.isReadOnly())
      : allTools;
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

  /**
   * Circuit-breaker: maximum LLM→tool iterations per turn.
   * plan: 10  |  debug: 15  |  full: 30
   */
  maxIterations(): number {
    return this.subMode === 'plan' ? 10 : this.subMode === 'debug' ? 15 : 30;
  }
}
