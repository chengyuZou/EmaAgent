// 这些工具负责后台启动子 Agent、发送协调消息并等待最终结果。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tools';
import type { ToolExecutionContext } from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

// ── SubagentSpawnBackground ───────────────────────────────────────────────────
//
// 异步拉起 sub-agent,立即返回其 ID。父循环继续 - 用 SubagentSendMessage
// 在执行中注入 coordinator 指令,用 SubagentAwait 收最终输出。

const spawnBgSchema = z.object({
  prompt: z.string().min(1).describe(
    'Self-contained task prompt. The sub-agent has no memory of the parent conversation.',
  ),
  model: z.string().optional().describe(
    'Override model ID. Defaults to the parent model.',
  ),
  description: z.string().optional().describe(
    'Short role description shown in the sub-agent dashboard.',
  ),
  kind: z.enum(['subagent', 'fork']).optional().describe(
    'Context strategy. Defaults to "subagent" (fresh context, no parent history) - appropriate ' +
      'for independent background workers. Use "fork" only when the worker explicitly needs ' +
      'the parent conversation history.',
  ),
});

export const SubagentSpawnBackgroundTool = buildTool<
  z.infer<typeof spawnBgSchema>,
  { subagentId: string }
>({
  id: BuiltinTools.SubagentSpawnBackground.id,
  name: BuiltinTools.SubagentSpawnBackground.name,
  description: `Start a sub-agent in the background and return its ID immediately.
The parent agent continues its own loop while the sub-agent runs concurrently.
Use SubagentSendMessage to inject coordinator instructions mid-execution.
Use SubagentAwait to block until the sub-agent finishes and collect its output.
The sub-agent MUST be awaited before the parent turn ends.`,

  inputSchema:       spawnBgSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  permissionMeta: { riskLevel: 'high', accessType: 'execute' },

  async execute(input, ctx: ToolExecutionContext) {
    if (!ctx.subagentSpawner?.spawnBackground) {
      throw new Error(
        'Sub-agents cannot spawn further sub-agents (depth limit: 1). ' +
        'Restructure the task so the top-level agent spawns all background workers directly.',
      );
    }
    const subagentId = randomUUID();
    ctx.subagentSpawner.spawnBackground(
      input.prompt,
      { model: input.model, description: input.description, kind: input.kind ?? 'subagent', subagentId },
      ctx.signal,
    );
    return { subagentId };
  },
});

// ── SubagentSendMessage ───────────────────────────────────────────────────────
//
// 向运行中的后台 sub-agent 邮箱注入一条 coordinator 消息。
// 消息在其下一次 LLM 迭代开始时送达。

const sendMsgSchema = z.object({
  subagentId: z.string().uuid().describe('ID returned by SubagentSpawnBackground.'),
  message:    z.string().min(1).describe(
    'Instruction or update to deliver to the sub-agent at its next iteration boundary.',
  ),
});

export const SubagentSendMessageTool = buildTool<
  z.infer<typeof sendMsgSchema>,
  { queued: boolean }
>({
  id: BuiltinTools.SubagentSendMessage.id,
  name: BuiltinTools.SubagentSendMessage.name,
  description: `Send a coordinator message to a running background sub-agent.
The message arrives at the start of the sub-agent's next LLM iteration.
Returns queued:false if the sub-agent has already finished or was never started.`,

  inputSchema:       sendMsgSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  permissionMeta: { riskLevel: 'low', accessType: 'write' },

  async execute(input, ctx: ToolExecutionContext) {
    if (!ctx.subagentSpawner?.queueMessage) {
      throw new Error(
        'SubagentSendMessage is only available to the top-level agent. ' +
        'Sub-agents cannot send messages to other sub-agents.',
      );
    }
    const queued = ctx.subagentSpawner.queueMessage(input.subagentId, input.message);
    return { queued };
  },
});

// ── SubagentAwait ─────────────────────────────────────────────────────────────
//
// 阻塞直到后台 sub-agent 完成,返回其输出。

const awaitSchema = z.object({
  subagentId: z.string().uuid().describe('ID returned by SubagentSpawnBackground.'),
});

export const SubagentAwaitTool = buildTool<
  z.infer<typeof awaitSchema>,
  { output: string; usage: { inputTokens: number; outputTokens: number } } | { output: null }
>({
  id: BuiltinTools.SubagentAwait.id,
  name: BuiltinTools.SubagentAwait.name,
  description: `Wait for a background sub-agent to finish and return its final output.
Must be called before the parent turn ends. Returns output:null if the subagentId is unknown.`,

  inputSchema:       awaitSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  async execute(input, ctx: ToolExecutionContext) {
    if (!ctx.subagentSpawner?.awaitBackground) {
      throw new Error(
        'SubagentAwait is only available to the top-level agent. ' +
        'Sub-agents cannot await other sub-agents.',
      );
    }
    const result = await ctx.subagentSpawner.awaitBackground(input.subagentId);
    if (!result) return { output: null };
    return result;
  },
});
