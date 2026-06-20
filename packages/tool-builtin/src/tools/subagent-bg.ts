import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTool } from '@ema-agent/tool';
import type { ToolExecutionContext } from '@ema-agent/tool';

// ── subagent_spawn_bg ─────────────────────────────────────────────────────────
//
// Fires off a sub-agent asynchronously and returns its ID immediately.
// The parent loop continues — use subagent_send_message to inject coordinator
// instructions mid-execution, and subagent_await to collect the final output.

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
    'Context strategy. Defaults to "subagent" (fresh context, no parent history) — appropriate ' +
      'for independent background workers. Use "fork" only when the worker explicitly needs ' +
      'the parent conversation history.',
  ),
});

export const subagentSpawnBgTool = buildTool<
  z.infer<typeof spawnBgSchema>,
  { subagentId: string }
>({
  name: 'subagent_spawn_bg',
  description: `Start a sub-agent in the background and return its ID immediately.
The parent agent continues its own loop while the sub-agent runs concurrently.
Use subagent_send_message to inject coordinator instructions mid-execution.
Use subagent_await to block until the sub-agent finishes and collect its output.
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

// ── subagent_send_message ─────────────────────────────────────────────────────
//
// Inject a coordinator message into a running background sub-agent's mailbox.
// The message is delivered at the start of its next LLM iteration.

const sendMsgSchema = z.object({
  subagentId: z.string().uuid().describe('ID returned by subagent_spawn_bg.'),
  message:    z.string().min(1).describe(
    'Instruction or update to deliver to the sub-agent at its next iteration boundary.',
  ),
});

export const subagentSendMessageTool = buildTool<
  z.infer<typeof sendMsgSchema>,
  { queued: boolean }
>({
  name: 'subagent_send_message',
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
        'subagent_send_message is only available to the top-level agent. ' +
        'Sub-agents cannot send messages to other sub-agents.',
      );
    }
    const queued = ctx.subagentSpawner.queueMessage(input.subagentId, input.message);
    return { queued };
  },
});

// ── subagent_await ────────────────────────────────────────────────────────────
//
// Block until a background sub-agent finishes and return its output.

const awaitSchema = z.object({
  subagentId: z.string().uuid().describe('ID returned by subagent_spawn_bg.'),
});

export const subagentAwaitTool = buildTool<
  z.infer<typeof awaitSchema>,
  { output: string; usage: { inputTokens: number; outputTokens: number } } | { output: null }
>({
  name: 'subagent_await',
  description: `Wait for a background sub-agent to finish and return its final output.
Must be called before the parent turn ends. Returns output:null if the subagentId is unknown.`,

  inputSchema:       awaitSchema,
  isReadOnly:        () => false,
  isConcurrencySafe: () => true,

  permissionMeta: { riskLevel: 'low', accessType: 'read' },

  async execute(input, ctx: ToolExecutionContext) {
    if (!ctx.subagentSpawner?.awaitBackground) {
      throw new Error(
        'subagent_await is only available to the top-level agent. ' +
        'Sub-agents cannot await other sub-agents.',
      );
    }
    const result = await ctx.subagentSpawner.awaitBackground(input.subagentId);
    if (!result) return { output: null };
    return result;
  },
});
