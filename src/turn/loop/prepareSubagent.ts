// 子 Agent 的 AgentLoopInput 工厂：subagent/fork 上下文、收窄 ToolPool、headless 执行器、不落根 Macro。
import {
  type AgentBudget,
  type PrepareSubagent,
} from '@ema-agent/agent';
import { createLlmCall } from '@ema-agent/llm';
import type { CallLlm, Message } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { BuiltinTools } from '@ema-agent/tools';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from '../preparation/prepareTurn.js';
import { createPrepareLlmCall } from './prepareLlmCall.js';

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
  readonly emit: (event: TurnStreamEvent) => void;
  readonly budget: AgentBudget;
  /** fork 子 Agent 继承的父工作消息；不含父 System Prompt、Tool Schema 或缓存标记。 */
  readonly parentMessages: Message[];
}

export function createPrepareSubagent(deps: PrepareSubagentDeps): PrepareSubagent {
  return async ({ agentRunId, prompt, options, signal }) => {
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
    const seed: Message[] = fork
      ? [...deps.parentMessages, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }];

    subPrepared = Object.freeze({
      ...subPrepared,
      systemPrompt: Object.freeze([{
        name: 'subagent',
        content: options.systemPrompt
          ?? '你是 Ema 的子 Agent，只完成被委派的具体任务，并把结论返回给父 Agent。',
      }]),
      tools: Object.freeze({
        ...subPrepared.tools,
        toolPool: subPool,
      }),
    });

    const prepareIteration = createPrepareLlmCall({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      prepared: subPrepared,
      compact,
      emit: deps.emit,
      baselineMessageCount: fork ? deps.parentMessages.length : 0,
      signal,
    });

    return {
      messages: seed,
      prepareIteration,
      callLlm,
      createToolExecutor: wake => prepared.tools.createSubagentExecutor({
        agentRunId,
        toolPool: subPool,
        signal,
        wake,
      }),
      budget: deps.budget,
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
