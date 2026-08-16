// 启动子 Agent: 默认同步等待完成, runInBackground 立即返回引用;
// 同步等待超限时自动转交后台(与 Bash 15s 转交同思想)。
// 模型说明书见 prompt.ts。
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  SubagentSpawnOptions,
  type SubagentSpawnerPort,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { SUBAGENT_DESCRIPTION } from './prompt.js';
import { AGENT_ROLES, DEFAULT_AGENT_ROLE, getAgentRole } from './agentRoles.js';

/** Subagent 工具的窄 Context：子 Agent 启动器;取消与身份走 ToolInvocation。 */
interface SubagentToolContext {
  spawner: SubagentSpawnerPort;
}

/**
 * 同步等待的转交阈值: 超过即把 AgentRun 转交后台并返回引用。
 * 比 Bash 的 15s 宽——子 Agent 的迭代粒度是 LLM 调用,不是进程输出。
 */
const AUTO_BACKGROUND_WAIT_MS = 30_000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

const ROLE_IDS = AGENT_ROLES.map((role) => role.agentType) as [string, ...string[]];

const inputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe(
      'Task prompt for the sub-agent. In the default "subagent" mode it must include all ' +
        'needed context because parent conversation history is not inherited.',
    ),
  role: z
    .enum(ROLE_IDS)
    .optional()
    .describe(
      `Sub-agent role (default "${DEFAULT_AGENT_ROLE}"). `
        + AGENT_ROLES.map((role) => `${role.agentType}: ${role.whenToUse}`).join(' '),
    ),
  providerId: z
    .string()
    .optional()
    .describe('Override provider ID for this sub-agent. Defaults to the parent agent\'s provider.'),
  modelId: z
    .string()
    .optional()
    .describe('Override model ID for this sub-agent. Defaults to the parent agent\'s model.'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Short description of this sub-agent\'s role (shown in the dashboard and logs).'),
  contextMode: z
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
  runInBackground: z
    .boolean()
    .optional()
    .describe('Return the agentRunId immediately and keep the agent running in the background.'),
});

type SubagentInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface SubagentCompletedResult {
  kind: 'completed';
  agentRunId: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SubagentBackgroundReference {
  kind: 'background';
  agentRunId: string;
  /** requested=模型显式要求后台; auto=同步等待超限自动转交。 */
  via: 'requested' | 'auto';
}

export type SubagentResult = SubagentCompletedResult | SubagentBackgroundReference;

// ── 限时等待(单次结算 + 对称清理) ─────────────────────────────────────────────

type WaitOutcome<T> =
  | { kind: 'result'; result: T }
  | { kind: 'timeout' }
  | { kind: 'aborted'; reason: unknown };

function raceWithAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitOutcome<T>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted', reason: signal.reason });
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      resolve({ kind: 'aborted', reason: signal.reason });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (result) => { cleanup(); resolve({ kind: 'result', result }); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const SubagentTool = buildTool<SubagentInput, SubagentResult, SubagentToolContext>({
  id: BuiltinTools.Subagent.id,
  name: BuiltinTools.Subagent.name,
  description: SUBAGENT_DESCRIPTION
    + `\n\nAvailable roles (role parameter; default "${DEFAULT_AGENT_ROLE}"):\n`
    + AGENT_ROLES.map((role) => `- ${role.agentType}: ${role.whenToUse}`).join('\n'),

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  getPermissionIntent: () => ({
    riskLevel: 'high',
    accessType: 'execute',
    promptPolicy: 'whenRequired',
  }),

  validateContext(ctx) {
    if (!ctx.subagentSpawner) {
      return contextFail('子 Agent 不能再启动子 Agent（深度限制: 1）。');
    }
    return contextOk({ spawner: ctx.subagentSpawner });
  },

  async execute(
    input: SubagentInput,
    context: SubagentToolContext,
    invocation: ToolInvocation,
  ): Promise<SubagentResult> {
    // 预分配 ID,以便 spawner 在阻塞前 emit subagent_started。
    // 所有 dashboard 事件(started/progress/stream/completed/failed/aborted)由
    // spawner emit - 它有 model/timing/usage 信息,工具没有。
    const agentRunId = randomUUID();
    const role = getAgentRole(input.role ?? DEFAULT_AGENT_ROLE);
    if (!role) {
      throw new Error(
        `Unknown subagent role: ${input.role}. Available: ${AGENT_ROLES.map((r) => r.agentType).join(', ')}`,
      );
    }
    const options: SubagentSpawnOptions = {
      providerId: input.providerId,
      modelId: input.modelId ?? role.modelId,
      description: input.description,
      contextMode: input.contextMode ?? role.contextMode ?? ('subagent' as const),
      agentRunId,
      taskId: input.taskId ? input.taskId : undefined,
      systemPrompt: role.systemPrompt,
      disallowedTools: role.disallowedTools,
    };

    if (input.runInBackground) {
      if (!context.spawner.spawnBackground) {
        throw new Error(
          'Sub-agents cannot spawn further sub-agents (depth limit: 1). ' +
            'Restructure the task so the top-level agent spawns all background workers directly.',
        );
      }
      context.spawner.spawnBackground(input.prompt, options, invocation.signal);
      return { kind: 'background', agentRunId, via: 'requested' };
    }

    // 同步路径: 有后台通路就"拉起 + 限时等待",超时自动转交后台。
    if (context.spawner.spawnBackground && context.spawner.awaitBackground) {
      context.spawner.spawnBackground(input.prompt, options, invocation.signal);
      const outcome = await raceWithAbort(
        context.spawner.awaitBackground(agentRunId),
        AUTO_BACKGROUND_WAIT_MS,
        invocation.signal,
      );
      if (outcome.kind === 'timeout') {
        return { kind: 'background', agentRunId, via: 'auto' };
      }
      if (outcome.kind === 'aborted') {
        // 同步等待被取消: 取消子 Agent 再抛,不留孤儿运行。
        context.spawner.abortSubagent?.(agentRunId);
        throw outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
      }
      if (!outcome.result) {
        throw new Error(`Sub-agent result unavailable (agentRunId: ${agentRunId})`);
      }
      return { kind: 'completed', ...outcome.result };
    }

    // 无后台通路的兜底宿主: 直接阻塞 spawn。
    const result = await context.spawner.spawn(input.prompt, options, invocation.signal);
    return { kind: 'completed', ...result };
  },

  mapResultToModelContent(output) {
    if (output.kind === 'background') {
      const via = output.via === 'auto'
        ? 'transferred to background after 30s'
        : 'started in the background';
      return `Sub-agent ${output.agentRunId} is ${via}. `
        + 'You will be notified when it completes — do not poll or sleep. '
        + 'Use SubagentAwait to collect the result within this turn.';
    }
    return output.output;
  },
});
