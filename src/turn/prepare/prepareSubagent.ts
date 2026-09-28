// 准备子 Agent 的模型调用, fork 分叉消息与执行工具.
import type { PrepareSubagent } from '@ema-agent/agent';
import { createLlmCall } from '@ema-agent/llm';
import type { CallLlm, Message, ToolResultBlock } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { BuiltinTools } from '@ema-agent/tools';
import type { UsageRecorder } from '@ema-agent/usage';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from './prepareTurn.js';
import { createPrepareAgentIteration } from './prepareAgentIteration.js';

/** 子 Agent 永不获得的能力：递归派发、Task 读写与用户交互；只从父 Pool 继续收窄。 */
const SUBAGENT_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  BuiltinTools.Subagent.name,
  BuiltinTools.SubagentAwait.name,
  BuiltinTools.TaskCreate.name,
  BuiltinTools.TaskGet.name,
  BuiltinTools.TaskList.name,
  BuiltinTools.TaskUpdate.name,
  BuiltinTools.TodoWrite.name,
  BuiltinTools.AskUser.name,
]);

export interface ForkParentMessages {
  /** 本次父请求准备完成后的工作历史, 不含正在生成的 Assistant. */
  readonly history: readonly Message[];
  /** 发起 fork 的完整 Assistant, 保留生成来源与原生推理块. */
  readonly assistant: Extract<Message, { role: 'assistant' }>;
}

const BACKGROUND_TASK_HANDOFF =
  '若命令转为后台任务且尚未完成, 在最终回复中提供 backgroundProcessId, 任务用途和最后已知状态, '
  + '供父 Agent 使用 ProcessOutput 接手. 不要用操作系统 PID 替代 backgroundProcessId, 不要把已启动说成已完成.';

export interface PrepareSubagentDeps {
  readonly sessionId: string;
  readonly turnId: string;
  /** 根 PreparedTurn 的延迟求值：工厂在准备期创建，子 Agent 只会在主循环中调用它。 */
  readonly prepared: () => PreparedTurn;
  readonly providers: Providers;
  /** 子 Agent 覆盖模型时解析子模型上下文预算（contextWindow/maxOutput）。 */
  readonly providerModels: ProviderModels;
  /** compact 工厂：覆盖模型时用子模型 callLlm 创建独立闭包（独立失败熔断）。 */
  readonly createCompact: (callLlm: CallLlm) => (request: CompactRequest) => Promise<CompactResult>;
  readonly usageRecorder?: UsageRecorder;
  readonly emit: (event: TurnStreamEvent) => void;
  /** 绑定调用所属的父请求, 等当前 Assistant 完整后交付一次; 取消只结束这个 fork 的等待. */
  readonly readParentMessages: (signal: AbortSignal) => Promise<ForkParentMessages>;
}

export function createPrepareSubagent(deps: PrepareSubagentDeps): PrepareSubagent {
  return async ({ subagentId, prompt, options, signal }) => {
    const prepared = deps.prepared();
    const providerId = options.providerId ?? prepared.providerId;
    const modelId = options.modelId ?? prepared.modelId;
    const overridden = providerId !== prepared.providerId || modelId !== prepared.modelId;

    // 覆盖模型时解析子模型自己的上下文预算并冻结进 subPrepared；thinking 意图
    // 继承根，由协议 Adapter 映射。模型调用可以复用，但每个循环的 Compact 状态独立。
    let callLlm = prepared.callLlm;
    let subPrepared: PreparedTurn = prepared;
    if (overridden) {
      const facts = deps.providerModels.get(providerId, 'llm', modelId);
      if (facts.capability !== 'llm') {
        throw new Error(`子 Agent 覆盖目标不是 LLM 模型：${providerId} / ${modelId}`);
      }
      const connection = deps.providers.resolveConnection(providerId, 'llm');
      callLlm = createLlmCall(connection, modelId);
      subPrepared = Object.freeze({
        ...prepared,
        providerId,
        modelId,
        protocol: connection.protocol,
        contextWindow: facts.contextWindow,
        maxOutput: facts.maxOutput,
      });
    }
    // 每个 AgentLoop 都有独立的连续失败状态；CallLlm 可以复用，Compact 闭包不能复用。
    const compact = deps.createCompact(callLlm);

    const disallowed = new Set([
      ...(options.disallowedTools ?? []),
      ...SUBAGENT_DENIED_TOOL_NAMES,
    ]);
    const subPool = prepared.tools.toolPool.filter(
      tool => !disallowed.has(tool.name),
    );

    const fork = options.contextMode === 'fork';
    let seed: Message[];
    let systemPrompt: PreparedTurn['systemPrompt'];
    if (fork) {
      const parent = await deps.readParentMessages(signal);
      signal.throwIfAborted();
      // 当前 Assistant 的真实工具结果仍归父循环. 只在子副本中补配对,
      // 不等待 fork 自己的结果, 也不把占位结果写回父 Session.
      const placeholders: ToolResultBlock[] = [];
      for (const block of parent.assistant.content) {
        if (block.type !== 'tool_use') continue;
        placeholders.push({
          type: 'tool_result',
          toolCallId: block.id,
          content: 'This call belongs to the parent agent. Its result is not available in this fork.',
        });
      }
      seed = [...parent.history, parent.assistant];
      if (placeholders.length > 0) {
        seed.push({ role: 'user', content: placeholders });
      }
      // 兄弟 fork 的继承前缀相同, 角色约束和各自任务都放在最后.
      const directive = [
        '你是从父 Agent 上下文分叉的子 Agent, 不是主 Agent. 只完成被委派的任务, 将结论返回给父 Agent.',
        '继承消息中的工具调用属于父 Agent, 不要因为它们出现在历史中就重新执行.',
        BACKGROUND_TASK_HANDOFF,
      ];
      if (options.systemPrompt) directive.push(options.systemPrompt);
      directive.push(`本次委派任务:\n${prompt}`);
      seed.push({ role: 'user', content: directive.join('\n\n') });
      systemPrompt = prepared.systemPrompt;
    } else {
      seed = [{ role: 'user', content: `${BACKGROUND_TASK_HANDOFF}\n\n${prompt}` }];
      systemPrompt = Object.freeze([{
        name: 'subagent',
        content: options.systemPrompt
          ?? '你是 EmaAgent 的子 Agent, 只完成被委派的具体任务, 并把结论返回给父 Agent.',
      }]);
    }

    subPrepared = Object.freeze({
      ...subPrepared,
      systemPrompt,
      tools: Object.freeze({
        ...subPrepared.tools,
        toolPool: subPool,
      }),
    });

    const prepareIteration = createPrepareAgentIteration({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      prepared: subPrepared,
      compact,
      usageRecorder: deps.usageRecorder,
      emit: deps.emit,
      signal,
    });

    return {
      messages: seed,
      prepareIteration,
      callLlm,
      createToolExecutor: wake => prepared.tools.createSubagentExecutor({
        subagentId,
        toolPool: subPool,
        signal,
        wake,
      }),
      signal,
      maxIterations: prepared.maxIterations,
      generationSource: {
        providerId: subPrepared.providerId,
        modelId: subPrepared.modelId,
        protocol: subPrepared.protocol,
      },
    };
  };
}
