// 同步启动子 Agent，并等待执行完成后返回结果。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asAgentRunId, asTaskId } from '@ema-agent/ids';
import { buildTool } from '@ema-agent/tools';
import type {
  SubagentSpawnerPort,
  SubagentRunResult,
} from '../../subagentToolPort.js';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import type { BuiltinToolContext } from '../../builtinToolContext.js';
import { contextFail, contextOk } from '../../contextValidation.js';

/** Subagent 工具的窄 Context：子 Agent 启动器 + per-call 取消信号。 */
interface SubagentToolContext {
  spawner: SubagentSpawnerPort;
  signal: AbortSignal;
}

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'Task prompt for the sub-agent. In the default "subagent" mode it must include all ' +
        'needed context because parent conversation history is not inherited.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override model ID for this sub-agent. Defaults to the parent agent\'s model.',
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Short description of this sub-agent\'s role (shown in the dashboard and logs).'),
  kind: z
    .enum(['subagent', 'fork'])
    .optional()
    .describe(
      'Context strategy. "subagent" is the default and starts with only the task prompt. ' +
        'Use "fork" only when the worker explicitly needs the parent conversation history.',
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

export const SubagentTool = buildTool<SubagentInput, SubagentRunResult, BuiltinToolContext, SubagentToolContext>({
  id: BuiltinTools.Subagent.id,
  name: BuiltinTools.Subagent.name,
  description: `Spawn a fresh sub-agent to handle a self-contained sub-task and return its final output.

The sub-agent:
- Starts with NO parent conversation history by default; choose \`kind: "fork"\` explicitly to inherit it.
- Uses the same workspace and permission/sandbox boundaries as the parent Turn.
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

  requires: ['subagentSpawner'],

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 不能再启动子 Agent（深度限制: 1）。');
    }
    return contextOk({
      spawner: ctx.subagentSpawner,
      signal: ctx.signal,
    });
  },

  async execute(
    input: SubagentInput,
    context: SubagentToolContext,
  ): Promise<SubagentRunResult> {
    // 预分配 ID,以便 spawner 在阻塞前 emit subagent_started。
    // 所有 dashboard 事件(started/progress/stream/completed/failed/aborted)由
    // spawner emit - 它有 model/timing/usage 信息,工具没有。
    const agentRunId = asAgentRunId(randomUUID());

    return context.spawner.spawn(
      input.prompt,
      {
        model: input.model,
        description: input.description,
        kind: input.kind ?? 'subagent',
        agentRunId,
        taskId: input.taskId ? asTaskId(input.taskId) : undefined,
      },
      context.signal,
    );
  },
});
