// 向运行中的后台子 Agent 邮箱注入一条协调消息;消息在其下一次 LLM 迭代开始时送达。
import { z } from 'zod';
import { asAgentRunId } from '@ema-agent/ids';
import {
  buildTool,
  contextFail,
  contextOk,
  type SubagentSpawnerPort,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** 窄 Context：启动器自带邮箱端口;身份与取消走 ToolInvocation。 */
interface SubagentSendMessageContext {
  spawner: SubagentSpawnerPort;
}

const inputSchema = z.object({
  agentRunId: z.string().uuid().describe('AgentRun ID returned by Subagent (runInBackground).'),
  message:    z.string().min(1).describe(
    'Instruction or update to deliver to the sub-agent at its next iteration boundary.',
  ),
});

type SubagentSendMessageInput = z.infer<typeof inputSchema>;

export interface SubagentSendMessageResult {
  queued: boolean;
}

export const SubagentSendMessageTool = buildTool<
  SubagentSendMessageInput,
  SubagentSendMessageResult,
  SubagentSendMessageContext
>({
  id: BuiltinTools.SubagentSendMessage.id,
  name: BuiltinTools.SubagentSendMessage.name,
  description: `Send a coordinator message to a running background sub-agent.
Use it for mid-run corrections ("also check X", "stop expanding scope") — it lands at the sub-agent's next LLM iteration.
It is a mailbox, not a chat channel: the sub-agent cannot reply through it.
Returns queued:false if the sub-agent has already finished or was never started.`,

  inputSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'write',
    promptPolicy: 'whenRequired',
  }),

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配（子 Agent 无此能力）。');
    }
    return contextOk({ spawner: ctx.subagentSpawner });
  },

  async execute(input, context: SubagentSendMessageContext) {
    if (!context.spawner.queueMessage) {
      throw new Error(
        'SubagentSendMessage is only available to the top-level agent. ' +
        'Sub-agents cannot send messages to other sub-agents.',
      );
    }
    const queued = context.spawner.queueMessage(asAgentRunId(input.agentRunId), input.message);
    return { queued };
  },

  mapResultToModelContent(output) {
    return output.queued
      ? 'Message queued; the sub-agent will see it at its next iteration.'
      : 'Message not delivered — the sub-agent has already finished or is unknown.';
  },
});
