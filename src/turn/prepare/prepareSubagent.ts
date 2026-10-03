// 准备子 Agent 的模型调用, fork 分叉消息与执行工具.
import type { ForkParentMessages, PrepareSubagent } from '@ema-agent/agent';
import { projectMessages } from '@ema-agent/context';
import { createLlmCall } from '@ema-agent/llm';
import type { CallLlm } from '@ema-agent/llm';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import type { ProviderModels, Providers } from '@ema-agent/providers';
import {
  staticSystemPrompt,
  getDynamicSystemPrompt,
  type DynamicSystemPromptInput,
  type PromptBlock,
} from '@ema-agent/prompts';
import { BuiltinTools } from '@ema-agent/tools';
import type { VisionDescriptionCache, VisionDescriptionProducer } from '@ema-agent/attachments';
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
  BuiltinTools.GoalGet.name,
  BuiltinTools.GoalUpdate.name,
  BuiltinTools.TodoWrite.name,
  BuiltinTools.AskUser.name,
]);

/** 放在通用规则之后, 明确它们在纯工作子代理中的身份和交付对象. */
const subagentPrompt: PromptBlock = {
  name: 'subagent',
  content: `# 子代理工作约束

你是 EmaAgent 的纯工作子代理, 不是前台主 Agent. 不使用当前激活角色的人设或角色扮演表达. 通用规则中的任务执行、安全、工具和事实核验要求仍然适用; 对用户沟通与最终交付在这里指向父 Agent, 你的报告由父 Agent 整合后转述给用户.

## 委派范围

只处理本次委派消息中的目标、范围和交付要求. 独立子代理从委派消息取得背景; fork 继承的父历史只是理解任务的材料, 不代表把父任务整体交给你. 不重新执行父历史里的工具调用, 不接管或持续推进父会话的 Goal. 继续旧会话时, 用自己的历史处理追加、纠错或继续要求, 不重复已经确认完成的工作.

## 执行与验证

先理解目标、已知事实、排除项和验收要求, 再使用本次工具池完成工作. 调查任务只交付调查结果, 不擅自实施; 实施任务只修改委派范围内的内容, 保留其他人的改动. 通用说明不提供工具池之外的能力, 也不放宽当前权限. 信息不足、工具拒绝或环境限制时, 如实向父 Agent 说明缺少什么, 不猜测批准、不换路径绕过限制.

验证规模应匹配风险. 区分读代码得到的判断和实际执行得到的结果; 不把“应该通过”、任务已启动或未运行的测试说成已验证完成. 遇到失败时报告真实错误、已尝试的办法和仍未完成的部分.

## 结果交付

最终报告给父 Agent, 不是直接对用户回复. 按委派要求说明结论、关键证据或文件位置、实际改动、验证结果和剩余问题. 内容足够父 Agent 接手, 不倾倒完整工具日志或复述无关父历史. 完成委派任务后结束本次执行, 不为父 Goal 自行追加新任务.

若命令转为尚未完成的后台任务, 在交付中提供 backgroundProcessId、任务用途和最后已知状态, 供父 Agent 使用 ProcessOutput 接手. 不用操作系统 PID 替代 backgroundProcessId, 不把已启动说成已完成.`,
};

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
  readonly visionCache?: VisionDescriptionCache;
  readonly describeImage?: VisionDescriptionProducer;
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

    // 覆盖模型时解析子模型自己的上下文预算并冻结进 subPrepared；thinking 意图
    // 继承根，由协议 Adapter 映射。模型调用可以复用，但每个循环的 Compact 状态独立。
    let callLlm = prepared.callLlm;
    let subPrepared: PreparedTurn = prepared;
    if (overridden) {
      const facts = deps.providerModels.get(providerId, 'llm', modelId);
      if (!facts || facts.capability !== 'llm') {
        throw new Error(`子 Agent 覆盖目标不是 LLM 模型：${providerId} / ${modelId}`);
      }
      const connection = deps.providers.resolveConnection(providerId, 'llm');
      callLlm = createLlmCall(connection, modelId);
      let thinking: PreparedTurn['thinking'];
      if (facts.reasoning === true) {
        if (prepared.reasoningEffort === 'off') thinking = { enabled: false };
        else thinking = { enabled: true, effort: prepared.reasoningEffort };
      }
      subPrepared = Object.freeze({
        ...prepared,
        providerId,
        modelId,
        protocol: connection.protocol,
        contextWindow: facts.contextWindow,
        maxOutput: facts.maxOutput,
        supportsImageInput: facts.inputImage === true,
        thinking,
      });
    }
    // 每个 AgentLoop 都有独立的连续失败状态；CallLlm 可以复用，Compact 闭包不能复用。
    const compact = deps.createCompact(callLlm);

    const subPool = prepared.tools.toolPool.filter(
      tool => !SUBAGENT_DENIED_TOOL_NAMES.has(tool.name),
    );

    // fork 只在新身份的首次调用读取父前缀. 复制与占位结果由 Agent 消息层负责.
    const parent = isNew && options.contextMode === 'fork'
      ? await deps.readParentMessages(signal)
      : undefined;
    signal.throwIfAborted();
    messageStore.initialize(subagentId, runId, prompt, parent);
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
    messageIds.push(...history.map(entry => entry.messageId));
    // 三种历史初始化路径共用 System. 不传父角色和 SessionMode,
    // 数据段沿用父调用已读取的文本, 环境模型和能力说明按实际子调用装配.
    const parentInput = prepared.DynamicSystemPromptInput;
    const dynamicInput: DynamicSystemPromptInput = Object.freeze({
      permissionMode: parentInput.permissionMode,
      toolNames: subPool.tools.map(tool => tool.name),
      environment: {
        ...parentInput.environment,
        providerId: subPrepared.providerId,
        modelId: subPrepared.modelId,
      },
      workspaceInstructions: parentInput.workspaceInstructions,
      memorySection: parentInput.memorySection,
      skillCatalog: parentInput.skillCatalog,
      mcpInstructions: parentInput.mcpInstructions,
    });
    const systemPrompt = Object.freeze([
      ...staticSystemPrompt,
      ...getDynamicSystemPrompt(dynamicInput),
      subagentPrompt,
    ]);

    subPrepared = Object.freeze({
      ...subPrepared,
      DynamicSystemPromptInput: dynamicInput,
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
      macroPersistence: {
        messageIds,
        appendSummary: (summary, throughMessageId, savedTokens) =>
          messageStore.appendSummary(subagentId, runId, summary, throughMessageId, savedTokens),
      },
    });

    return {
      messages: history.map(entry => entry.message),
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
