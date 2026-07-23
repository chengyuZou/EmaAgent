// 同步启动子 Agent，并等待执行完成后返回结果。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asAgentRunId, asTaskId } from '@ema-agent/ids';
import { buildTool } from '@ema-agent/tools';
import type {
  ISubagentSpawner,
  SubagentRunResult,
  ToolExecutionContext,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'Self-contained task prompt for the sub-agent. Must include all context needed - ' +
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
    .describe('Short description of this sub-agent\'s role (shown in the dashboard and logs).'),
  kind: z
    .enum(['subagent', 'fork'])
    .optional()
    .describe(
      'Context strategy. "fork" (default) inherits the parent conversation history - use when ' +
        'the sub-agent needs prior context. "subagent" starts fresh with only the task prompt - ' +
        'use for independent parallel workers to save tokens and avoid context bleed.',
    ),
  taskId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Optional existing Task UUID to associate with this AgentRun. The Task must be in the current Session, non-terminal, and unblocked.',
    ),
});

type SubagentInput = z.infer<typeof inputSchema>;

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const SubagentTool = buildTool<SubagentInput, SubagentRunResult>({
  id: BuiltinTools.Subagent.id,
  name: BuiltinTools.Subagent.name,
  description: `Spawn a fresh sub-agent to handle a self-contained sub-task and return its final output.

The sub-agent:
- Has NO memory of the parent conversation - the \`prompt\` must be fully self-contained.
- Runs its own think->act loop and reports back when done.
- Is cancelled automatically if the parent turn is aborted.
- Useful for parallelizable research, code review, or isolated refactors.`,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  permissionMeta: {
    riskLevel: 'high',
    accessType: 'execute',
  },

  async execute(input: SubagentInput, ctx: ToolExecutionContext): Promise<SubagentRunResult> {
    const spawner: ISubagentSpawner | undefined = ctx.subagentSpawner;
    if (!spawner) {
      throw new Error(
        'Sub-agents cannot spawn further sub-agents (depth limit: 1). ' +
        'If you need nested parallelism, restructure the task so the top-level agent spawns all workers directly.',
      );
    }

    // 预分配 ID,以便 spawner 在阻塞前 emit subagent_started。
    // 所有 dashboard 事件(started/progress/stream/completed/failed/aborted)由
    // spawner emit - 它有 model/timing/usage 信息,工具没有。
    const agentRunId = asAgentRunId(randomUUID());

    return spawner.spawn(
      input.prompt,
      {
        model: input.model,
        description: input.description,
        kind: input.kind,
        agentRunId,
        taskId: input.taskId ? asTaskId(input.taskId) : undefined,
      },
      ctx.signal,
    );
  },
});
