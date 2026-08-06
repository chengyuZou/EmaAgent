// 阻塞等待后台子 Agent 完成并取回最终输出。
import { z } from 'zod';
import { asAgentRunId } from '@ema-agent/ids';
import {
  buildTool,
  contextFail,
  contextOk,
  type SubagentSpawnerPort,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** 窄 Context：启动器自带等待端口;身份与取消走 ToolInvocation。 */
interface SubagentAwaitContext {
  spawner: SubagentSpawnerPort;
}

const inputSchema = z.object({
  agentRunId: z.string().uuid().describe('AgentRun ID returned by Subagent (runInBackground).'),
});

type SubagentAwaitInput = z.infer<typeof inputSchema>;

export type SubagentAwaitResult =
  | { output: string; usage: { inputTokens: number; outputTokens: number } }
  | { output: null };

export const SubagentAwaitTool = buildTool<
  SubagentAwaitInput,
  SubagentAwaitResult,
  SubagentAwaitContext
>({
  id: BuiltinTools.SubagentAwait.id,
  name: BuiltinTools.SubagentAwait.name,
  description: `Wait for a background sub-agent to finish and return its final output.
Use it when you need the result before you can continue the current turn.
If you do not need the result yet, continue with other work — you will be notified when it completes; do not poll.
Returns output:null if the agentRunId is unknown or already collected.`,

  inputSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配（子 Agent 无此能力）。');
    }
    return contextOk({ spawner: ctx.subagentSpawner });
  },

  async execute(input, context: SubagentAwaitContext) {
    if (!context.spawner.awaitBackground) {
      throw new Error(
        'SubagentAwait is only available to the top-level agent. ' +
        'Sub-agents cannot await other sub-agents.',
      );
    }
    const result = await context.spawner.awaitBackground(asAgentRunId(input.agentRunId));
    if (!result) return { output: null };
    return { output: result.output, usage: result.usage };
  },

  mapResultToModelContent(output) {
    if (output.output === null) {
      return 'No result available — the agentRunId is unknown or the result was already collected.';
    }
    return output.output;
  },
});
