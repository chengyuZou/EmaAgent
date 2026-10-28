import type { ForkParentMessages, PrepareSubagent } from '@ema-agent/agent';
import { projectMessages, type DescribeImage } from '@ema-agent/context';
import { createLLMCall, createLLMCompletion, type CompleteLLM } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import { staticSystemPrompt, getDynamicSystemPrompt, type DynamicSystemPromptInput, subagentPrompt } from '@ema-agent/prompts';
import { restrictSubagentTools } from '../policy/subagentToolPolicy.js';
import type { VisionDescriptionCache } from '@ema-agent/attachments';
import type { UsageRecorder } from '@ema-agent/usage';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from '../prepare/prepareTurn.js';
import { createPrepareAgentIteration } from '../prepare/prepareAgentIteration.js';

export interface PrepareSubagentDeps {
  readonly sessionId: string;
  readonly turnId: string;
  /** 根 PreparedTurn 的延迟求值:工厂在准备期创建,子 Agent 只会在主循环中调用它. */
  readonly prepared: () => PreparedTurn;
  readonly providers: Providers;
  /** 子 Agent 覆盖模型时解析子模型上下文预算(contextWindow/maxOutput). */
  readonly providerModels: ProviderModels;
  /** 每个子代理独立保存压缩失败次数, 摘要请求使用子代理选定的模型. */
  readonly createCompact: (completeLLM: CompleteLLM) => (request: CompactRequest) => Promise<CompactResult>;
  readonly usageRecorder?: UsageRecorder;
  readonly visionCache?: VisionDescriptionCache;
  readonly describeImage?: DescribeImage;
  readonly emit: (event: TurnStreamEvent) => void;
  /** 绑定调用所属的父请求, 等当前 Assistant 完整后交付一次; 取消只结束这个 fork 的等待. */
  readonly readParentMessages: (signal: AbortSignal) => Promise<ForkParentMessages>;
}

export function createPrepareSubagent(deps: PrepareSubagentDeps): PrepareSubagent {
  return async ({ subagentId, runId, isNew, messageStore, messageIds, prompt, options, signal }) => {
    const prepared = deps.prepared();
    const providerId = options.providerId ?? prepared.providerId;
    const modelId = options.modelId ?? prepared.modelId;
    const overridden = providerId !== prepared.providerId || modelId !== prepared.modelId;

    // 覆盖模型时解析子模型自己的上下文预算并冻结进 subPrepared;thinking 意图
    // 继承根,由协议 Adapter 映射.模型调用可以复用,但每个循环的 Compact 状态独立.
    let callLLM = prepared.callLLM;
    let subPrepared: PreparedTurn = prepared;
    if (overridden) {
      const facts = deps.providerModels.get(providerId, 'llm', modelId);
      if (!facts || facts.capability !== 'llm') {
        throw new Error(`子 Agent 覆盖目标不是 LLM 模型:${providerId} / ${modelId}`);
      }
      const connection = deps.providers.resolveConnection(providerId, 'llm');
      callLLM = createLLMCall(connection, modelId);
      let thinking: PreparedTurn['thinking'];
      if (facts.reasoning === true) {
        if (prepared.reasoningEffort === 'off') {
          thinking = { enabled: false };
        } else {
          thinking = { enabled: true, effort: prepared.reasoningEffort };
        }
      }
      subPrepared = Object.freeze({
        ...prepared,
        providerId,
        modelId,
        callLLM,
        completeLLM: createLLMCompletion(connection, modelId),
        protocol: connection.protocol,
        contextWindow: facts.contextWindow,
        maxOutput: facts.maxOutput,
        supportsImageInput: facts.inputImage === true,
        thinking,
      });
    }
    const subPool = restrictSubagentTools(prepared.tools.toolPool);

    // fork 只在新身份的首次调用读取父前缀. 复制与占位结果由 Agent 消息层负责.
    const parent = isNew && options.contextMode === 'fork'
      ? await deps.readParentMessages(signal)
      : undefined;
    signal.throwIfAborted();
    messageStore.initialize(
      subagentId,
      runId,
      prompt,
      parent
    );
    const history = await projectMessages(
      messageStore.loadHistory(subagentId),
      message => message.generatedBy,
      {
        supportsImageInput: subPrepared.supportsImageInput,
        ...(deps.visionCache ? { visionCache: deps.visionCache } : {}),
        ...(deps.describeImage ? { describeImage: deps.describeImage } : {}),
        signal,
      },
    );
    messageIds.setInitialHistory(history.map(entry => entry.messageId));
    // 三种历史初始化路径共用 System. 不传父角色,
    // 数据段沿用父调用已读取的文本, 环境模型和能力说明按实际子调用装配.
    const parentInput = prepared.dynamicSystemPromptInput;
    const dynamicInput: DynamicSystemPromptInput = Object.freeze({
      permissionMode: parentInput.permissionMode,
      toolNames: subPool.tools.map(tool => tool.name),
      environment: { ...parentInput.environment, providerId: subPrepared.providerId, modelId: subPrepared.modelId },
      workspaceInstructions: parentInput.workspaceInstructions,
      memorySection: parentInput.memorySection,
      skillCatalog: parentInput.skillCatalog,
    });
    const systemPrompt = Object.freeze([...staticSystemPrompt, ...getDynamicSystemPrompt(dynamicInput), subagentPrompt]);

    subPrepared = Object.freeze({
      ...subPrepared,
      dynamicSystemPromptInput: dynamicInput,
      systemPrompt,
      tools: Object.freeze({ ...subPrepared.tools, toolPool: subPool }),
    });

    const prepareIteration = createPrepareAgentIteration({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      prepared: subPrepared,
      createCompact: deps.createCompact,
      usageRecorder: deps.usageRecorder,
      emit: deps.emit,
      signal,
      macroPersistence: {
        messageIds,
        appendSummary: (summary, throughMessageId, savedTokens) =>
          messageStore.appendSummary(
            subagentId,
            runId,
            summary,
            throughMessageId,
            savedTokens
          ),
      },
    });

    return {
      messages: history.map(entry => entry.message),
      prepareIteration,
      callLLM,
      createToolExecutor: wake => prepared.tools.createSubagentExecutor({ subagentId, runId, toolPool: subPool, signal, wake }),
      signal,
      maxIterations: prepared.maxIterations,
      generationSource: { providerId: subPrepared.providerId, modelId: subPrepared.modelId, protocol: subPrepared.protocol },
    };
  };
}
