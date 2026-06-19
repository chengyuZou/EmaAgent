import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext, ISubagentSpawner } from '@ema-agent/tool';

// ── Input schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'Self-contained task prompt for the sub-agent. Must include all context needed — ' +
        'the sub-agent has no memory of the parent agent\'s conversation.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override model ID for this sub-agent. Defaults to the parent agent\'s model.',
    ),
  description: z
    .string()
    .optional()
    .describe('Short description of this sub-agent\'s role (shown in logs and UI).'),
});

type SubagentInput = z.infer<typeof inputSchema>;

// ── Output type ───────────────────────────────────────────────────────────────

export interface SubagentResult {
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const subagentTool = buildTool<SubagentInput, SubagentResult>({
  name: 'subagent',
  description: `Spawn a fresh sub-agent to handle a self-contained sub-task and return its final output.

The sub-agent:
- Has NO memory of the parent conversation — the \`prompt\` must be fully self-contained.
- Runs its own think→act loop and reports back when done.
- Is cancelled automatically if the parent turn is aborted.
- Useful for parallelizable research, code review, or isolated refactors.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
  },

  async execute(input: SubagentInput, ctx: ToolExecutionContext): Promise<SubagentResult> {
    const spawner: ISubagentSpawner | undefined = ctx.subagentSpawner;
    if (!spawner) {
      throw new Error(
        'Sub-agent spawner is not configured. The AgentEngine must inject a subagentSpawner into the execution context.',
      );
    }

    return spawner.spawn(
      input.prompt,
      {
        model: input.model,
        description: input.description,
      },
      ctx.signal,
    );
  },
});
