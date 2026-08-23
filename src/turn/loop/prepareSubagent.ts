// 子 Agent 的 AgentLoopInput 工厂：clean/fork 上下文、收窄 ToolPool、headless 执行器、不落根 Macro。
import {
  type AgentBudget,
  type PrepareSubagent,
} from '@ema-agent/agent';
import { createLlmCall } from '@ema-agent/llm';
import type { Message } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { Providers } from '@ema-agent/providers';
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
  readonly compact: (request: CompactRequest) => Promise<CompactResult>;
  readonly emit: (event: TurnStreamEvent) => void;
  readonly budget: AgentBudget;
  /** fork 子 Agent 继承的最终请求视图；根 Turn 每次请求装配后 splice 更新。 */
  readonly parentMessages: Message[];
}

export function createPrepareSubagent(deps: PrepareSubagentDeps): PrepareSubagent {
  return async ({ agentRunId, prompt, options, signal }) => {
    const prepared = deps.prepared();
    const providerId = options.providerId ?? prepared.providerId;
    const modelId = options.modelId ?? prepared.modelId;
    const callLlm = providerId === prepared.providerId && modelId === prepared.modelId
      ? prepared.callLlm
      : createLlmCall(deps.providers.resolveConnection(providerId, 'llm'), modelId);

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

    const subPrepared: PreparedTurn = Object.freeze({
      ...prepared,
      systemPrompt: Object.freeze([
        options.systemPrompt
          ?? '你是 Ema 的子 Agent，只完成被委派的具体任务，并把结论返回给父 Agent。',
      ]),
      tools: Object.freeze({
        ...prepared.tools,
        toolPool: subPool,
      }),
    });

    const prepareIteration = createPrepareLlmCall({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      prepared: subPrepared,
      compact: deps.compact,
      emit: deps.emit,
      budget: deps.budget,
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
    };
  };
}
