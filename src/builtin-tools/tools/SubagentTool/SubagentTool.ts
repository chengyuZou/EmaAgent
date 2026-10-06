// 启动子 Agent: 默认同步等待完成, runInBackground 立即返回引用;
// 同步等待超限时自动转交后台.
// 模型说明书见 prompt.ts。
import { z } from 'zod';
import {
  buildTool,
  contextFail,
  contextOk,
  ToolExecutionError,
  type SubagentSpawnOptions,
  type SubagentControl,
  type ToolInvocation,
} from '@ema-agent/tools';
import { BuiltinTools } from '../../BuiltinToolIdentity.js';
import { SUBAGENT_DESCRIPTION } from './prompt.js';

/** Subagent 工具的窄 Context：子 Agent 启动器;取消与身份走 ToolInvocation。 */
interface SubagentToolContext {
  subagents: SubagentControl;
}

/**
 * 同步等待的转交阈值: 超过即把 Subagent 转交后台并返回引用。
 * 子 Agent 按独立的等待阈值转交, 不使用 Shell 命令的前台等待时间.
 */
const AUTO_BACKGROUND_WAIT_MS = 120_000;

// ── 输入 schema ──────────────────────────────────────────────────────────────

const inputSchema = z.object({
  subagentId: z.string().min(1).optional()
    .describe('Continue this existing sub-agent. Omit to create a new sub-agent.'),
  title: z.string().trim().min(1).optional()
    .describe('Required when creating a new sub-agent. Continuing keeps its title unless explicitly supplied.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'Task prompt for the sub-agent. In the default "subagent" mode it must include all ' +
      'needed context because parent conversation history is not inherited.',
    ),
  providerId: z
    .string()
    .optional()
    .describe(
      'Provider of the model override. Must be given together with modelId — ' +
      'a modelId alone is not unique across providers. New agents inherit the parent; continued agents keep their last model.',
    ),
  modelId: z
    .string()
    .optional()
    .describe(
      'Model override for this sub-agent. Must be given together with providerId. ' +
      'New agents inherit the parent; continued agents keep their last model.',
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Short description of this sub-agent\'s work, used to recognize it for later continuation.'),
  contextMode: z
    .enum(['subagent', 'fork'])
    .optional()
    .describe(
      'Context strategy. "subagent" is the default and starts with only the task prompt. ' +
      'Use "fork" only when the worker explicitly needs the parent conversation history.',
    ),
  runInBackground: z
    .boolean()
    .optional()
    .describe('Return the subagentId immediately and keep the agent running in the background.'),
});

type SubagentInput = z.infer<typeof inputSchema>;

// ── 输出类型 ───────────────────────────────────────────────────────────────────

export interface SubagentCompletedResult {
  kind: 'completed';
  subagentId: string;
  runId: string;
  output: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SubagentBackgroundReference {
  kind: 'background';
  subagentId: string;
  runId: string;
  /** requested=模型显式要求后台; auto=同步等待超限自动转交。 */
  via: 'requested' | 'auto';
}

export type SubagentResult = SubagentCompletedResult | SubagentBackgroundReference;

// ── 限时等待(单次结算 + 对称清理) ─────────────────────────────────────────────

type WaitOutcome<T> =
  | { kind: 'result'; result: T }
  | { kind: 'timeout' }
  | { kind: 'aborted'; reason: unknown };

function raceWithAbort<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<WaitOutcome<T>> {
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
    void promise.then((result) => {
      cleanup();
      resolve({ kind: 'result', result });
    },
      (error: unknown) => {
        cleanup();
        reject(error);
      });
  });
}

// ── 工具定义 ───────────────────────────────────────────────────────────────────

export const SubagentTool = buildTool<SubagentInput, SubagentResult, SubagentToolContext>({
  id: BuiltinTools.Subagent.id,
  name: BuiltinTools.Subagent.name,
  description: SUBAGENT_DESCRIPTION,

  inputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  // 启动子 Agent 有副作用与成本, 交给中央规则与模式收口(默认询问)。
  checkPermissions: async () => ({ behavior: 'passthrough', message: '启动子 Agent 需要用户确认' }),

  validateContext(ctx) {
    if (!ctx.subagents) {
      return contextFail('子 Agent 不能再启动子 Agent（深度限制: 1）。');
    }
    return contextOk({ subagents: ctx.subagents });
  },

  async execute(input: SubagentInput, context: SubagentToolContext, invocation: ToolInvocation): Promise<SubagentResult> {
    if (!input.subagentId && (!input.title || !input.description)) {
      throw new Error('Creating a sub-agent requires title and description.');
    }
    const { modelId, providerId } = input;
    // modelId 跨 provider 不唯一（同名可能是不同权重/量化/托管）；
    // 只给 modelId 不给 providerId = 让编排层猜，直接拒绝。
    if ((modelId === undefined) !== (providerId === undefined)) {
      throw new Error(
        'Sub-agent model override requires both providerId and modelId. ' +
        'A modelId alone is ambiguous — the same model id can exist on multiple providers.',
      );
    }
    const options: SubagentSpawnOptions = {
      subagentId: input.subagentId,
      title: input.title,
      providerId,
      modelId,
      description: input.description,
      contextMode: input.contextMode ?? (input.subagentId ? undefined : 'subagent'),
    };

    if (input.runInBackground) {
      const reference = context.subagents.start(
        input.prompt,
        options,
        invocation.toolCallId,
        true,
        invocation.signal
      );
      return { kind: 'background', ...reference, via: 'requested' };
    }

    // 同步路径: 后台拉起 + 限时等待，超时自动转交后台。
    const reference = context.subagents.start(
      input.prompt,
      options,
      invocation.toolCallId,
      false,
      invocation.signal
    );
    const { subagentId } = reference;
    try {
      const outcome = await raceWithAbort(
        context.subagents.waitForInitialResult(subagentId, invocation.signal),
        AUTO_BACKGROUND_WAIT_MS,
        invocation.signal,
      );
      if (outcome.kind === 'timeout') {
        context.subagents.moveToBackground(subagentId);
        return { kind: 'background', ...reference, via: 'auto' };
      }
      if (outcome.kind === 'aborted') {
        // 同步等待被取消: 取消子 Agent 再抛,不留孤儿运行。
        context.subagents.cancel(subagentId);
        throw outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
      }
      if (!outcome.result) {
        throw new Error(`Sub-agent result unavailable (subagentId: ${subagentId})`);
      }
      return { kind: 'completed', ...outcome.result };
    } catch (error) {
      // start 已成功才有这份引用. 错误与业务输出分开, 失败卡片仍能打开本次 Run.
      throw new ToolExecutionError(
        reference,
        error instanceof Error ? error.message : String(error),
        invocation.signal.aborted ? 'tool/cancelled' : 'tool/error'
      );
    }
  },

  mapResultToModelContent(output) {
    if (output.kind === 'background') {
      const via = output.via === 'auto'
        ? 'transferred to background after 120s'
        : 'started in the background';
      return `Sub-agent ${output.subagentId} is ${via}. `
        + 'You will be notified when it completes — do not poll or sleep. '
        + 'Use SubagentAwait to collect the result within this turn.';
    }
    return `Sub-agent ${output.subagentId} completed.\n${output.output}`;
  },
});
