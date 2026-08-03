// 后台启动子 Agent、发送协调消息并等待最终结果。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asAgentRunId, asTaskId } from '@ema-agent/ids';
import {
  buildTool,
  contextFail,
  contextOk,
  type BuiltinToolContext,
  type SubagentSpawnerPort,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';

/** 后台子 Agent 工具族的窄 Context：启动器 + per-call 取消信号（SpawnBackground 用）。 */
interface BackgroundSubagentToolContext {
  spawner: SubagentSpawnerPort;
  signal: AbortSignal;
}

// ── SubagentSpawnBackground ───────────────────────────────────────────────────
//
// 异步拉起 sub-agent,立即返回其 ID。父循环继续 - 用 SubagentSendMessage
// 在执行中注入 coordinator 指令,用 SubagentAwait 收最终输出。

const spawnBgSchema = z.object({
  prompt: z.string().min(1).describe(
    'Task prompt. In the default "subagent" mode it must include all needed context.',
  ),
  model: z.string().optional().describe(
    'Override model ID. Defaults to the parent model.',
  ),
  description: z.string().trim().min(1).max(200).describe(
    'Short role description shown in the sub-agent dashboard.',
  ),
  kind: z.enum(['subagent', 'fork']).optional().describe(
    'Context strategy. Defaults to "subagent" (fresh context, no parent history) - appropriate ' +
      'for independent background workers. Use "fork" only when the worker explicitly needs ' +
      'the parent conversation history.',
  ),
  taskId: z.string().uuid().optional().describe(
    'Optional existing Task UUID to associate with this AgentRun. The Task must be available and unblocked.',
  ),
});

export const SubagentSpawnBackgroundTool = buildTool<
  z.infer<typeof spawnBgSchema>,
  { agentRunId: string },
  BuiltinToolContext,
  BackgroundSubagentToolContext
>({
  id: BuiltinTools.SubagentSpawnBackground.id,
  name: BuiltinTools.SubagentSpawnBackground.name,
  description: `Start a sub-agent in the background and return its ID immediately.
The parent agent continues its own loop while the sub-agent runs concurrently.
Use SubagentSendMessage to inject coordinator instructions mid-execution.
Use SubagentAbort when the result is no longer needed.
Use SubagentAwait to block until the sub-agent finishes and collect its output.
The sub-agent MUST be awaited before the parent turn ends.`,

  inputSchema:       spawnBgSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'high',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  }),

  requires: ['subagentSpawner'],

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配。');
    }
    return contextOk({
      spawner: ctx.subagentSpawner,
      signal: ctx.signal,
    });
  },

  async execute(input, context: BackgroundSubagentToolContext) {
    if (!context.spawner.spawnBackground) {
      throw new Error(
        'Sub-agents cannot spawn further sub-agents (depth limit: 1). ' +
        'Restructure the task so the top-level agent spawns all background workers directly.',
      );
    }
    const agentRunId = asAgentRunId(randomUUID());
    context.spawner.spawnBackground(
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
    return { agentRunId };
  },
});

// ── SubagentSendMessage ───────────────────────────────────────────────────────
//
// 向运行中的后台 sub-agent 邮箱注入一条 coordinator 消息。
// 消息在其下一次 LLM 迭代开始时送达。

const sendMsgSchema = z.object({
  agentRunId: z.string().uuid().describe('AgentRun ID returned by SubagentSpawnBackground.'),
  message:    z.string().min(1).describe(
    'Instruction or update to deliver to the sub-agent at its next iteration boundary.',
  ),
});

export const SubagentSendMessageTool = buildTool<
  z.infer<typeof sendMsgSchema>,
  { queued: boolean },
  BuiltinToolContext,
  BackgroundSubagentToolContext
>({
  id: BuiltinTools.SubagentSendMessage.id,
  name: BuiltinTools.SubagentSendMessage.name,
  description: `Send a coordinator message to a running background sub-agent.
The message arrives at the start of the sub-agent's next LLM iteration.
Returns queued:false if the sub-agent has already finished or was never started.`,

  inputSchema:       sendMsgSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'write',
    promptPolicy: 'whenRequired',
  }),

  requires: ['subagentSpawner'],

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配。');
    }
    return contextOk({
      spawner: ctx.subagentSpawner,
      signal: ctx.signal,
    });
  },

  async execute(input, context: BackgroundSubagentToolContext) {
    if (!context.spawner.queueMessage) {
      throw new Error(
        'SubagentSendMessage is only available to the top-level agent. ' +
        'Sub-agents cannot send messages to other sub-agents.',
      );
    }
    const queued = context.spawner.queueMessage(asAgentRunId(input.agentRunId), input.message);
    return { queued };
  },
});

// ── SubagentAwait ─────────────────────────────────────────────────────────────
//
// 阻塞直到后台 sub-agent 完成,返回其输出。

const awaitSchema = z.object({
  agentRunId: z.string().uuid().describe('AgentRun ID returned by SubagentSpawnBackground.'),
});

export const SubagentAwaitTool = buildTool<
  z.infer<typeof awaitSchema>,
  { output: string; usage: { inputTokens: number; outputTokens: number } } | { output: null },
  BuiltinToolContext,
  BackgroundSubagentToolContext
>({
  id: BuiltinTools.SubagentAwait.id,
  name: BuiltinTools.SubagentAwait.name,
  description: `Wait for a background sub-agent to finish and return its final output.
Must be called before the parent turn ends. Returns output:null if the agentRunId is unknown.`,

  inputSchema:       awaitSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'read',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  requires: ['subagentSpawner'],

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配。');
    }
    return contextOk({
      spawner: ctx.subagentSpawner,
      signal: ctx.signal,
    });
  },

  async execute(input, context: BackgroundSubagentToolContext) {
    if (!context.spawner.awaitBackground) {
      throw new Error(
        'SubagentAwait is only available to the top-level agent. ' +
        'Sub-agents cannot await other sub-agents.',
      );
    }
    const result = await context.spawner.awaitBackground(asAgentRunId(input.agentRunId));
    if (!result) return { output: null };
    return result;
  },
});

// ── SubagentAbort ─────────────────────────────────────────────────────────────

const abortSchema = z.object({
  agentRunId: z.string().uuid().describe('AgentRun ID returned by SubagentSpawnBackground.'),
});

export const SubagentAbortTool = buildTool<
  z.infer<typeof abortSchema>,
  { aborted: boolean },
  BuiltinToolContext,
  BackgroundSubagentToolContext
>({
  id: BuiltinTools.SubagentAbort.id,
  name: BuiltinTools.SubagentAbort.name,
  description: `Cancel one running background sub-agent without cancelling the parent Turn.
Returns aborted:false if the AgentRun is unknown or has already finished.`,

  inputSchema:       abortSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'low',
    accessType: 'write',
    promptPolicy: 'neverForTrustedBuiltin',
  }),

  requires: ['subagentSpawner'],

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 启动器未装配。');
    }
    return contextOk({
      spawner: ctx.subagentSpawner,
      signal: ctx.signal,
    });
  },

  async execute(input, context: BackgroundSubagentToolContext) {
    if (!context.spawner.abortSubagent) {
      throw new Error(
        'SubagentAbort is only available to the top-level agent. ' +
        'Sub-agents cannot cancel other sub-agents.',
      );
    }
    return {
      aborted: context.spawner.abortSubagent(asAgentRunId(input.agentRunId)),
    };
  },
});
