import type { ModelMessageIds, PrepareAgentIteration } from '@ema-agent/agent';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import {
  assembleContext,
  type ContextUsageEstimate,
  type PreparedContext,
} from '@ema-agent/context';
import type { CompleteLLM, Message } from '@ema-agent/llm';
import type { UsageRecorder } from '@ema-agent/usage';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from './prepareTurn.js';

export interface PrepareAgentIterationDeps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prepared: PreparedTurn;
  readonly createCompact: (completeLLM: CompleteLLM) => (request: CompactRequest) => Promise<CompactResult>;
  readonly usageRecorder?: UsageRecorder;
  readonly emit: (event: TurnStreamEvent) => void;
  /**
   * 主 Agent 和子代理分别保存自己的摘要. messageIds 与 AgentLoop 的消息位置一一对应.
   * 摘要覆盖边界取被覆盖前缀的最后一个已保存 ID, 不能用模型数组下标推算 SQL 范围.
   */
  readonly macroPersistence?: {
    readonly appendSummary: (
      summary: string, summarizedThroughMessageId: string, savedTokens: number,
    ) => { readonly id: string };
    readonly messageIds: ModelMessageIds;
  };
  readonly signal: AbortSignal;
  /** 主 Agent 的最终请求装配完成后发布; 子 Agent 省略, 因此不会更新 Session Context. */
  readonly onContextPrepared?: (
    llmCallId: string,
    estimate: ContextUsageEstimate,
  ) => void;
}

/**
 * 历史, reminder 与本 Turn 消息是同一个可压缩数组. Macro 用被覆盖前缀的
 * 最后一条已落库消息作为 SQL 游标. 输出截断后的续写通知也先保存, 再加入可压缩历史.
 */
export function createPrepareAgentIteration(deps: PrepareAgentIterationDeps): PrepareAgentIteration {
  const { prepared, macroPersistence } = deps;
  const compact = deps.createCompact(prepared.completeLLM);

  return async ({ llmCallId, messages, recoveryReason }) => {
    const assemble = (currentMessages: readonly Message[]): PreparedContext =>
      assembleContext({
        systemPrompt: prepared.systemPrompt,
        toolPool: prepared.tools.toolPool,
        messages: currentMessages,
        contextWindow: prepared.contextWindow,
      });

    let assembled = assemble(messages);
    // 摘要请求复用本轮系统消息和缓存断点. 是否命中 Provider 缓存由实际协议和服务决定.
    const systemEnd = assembled.messages.findIndex(message => message.role !== 'system');
    const systemMessages = assembled.messages.slice(
      0,
      systemEnd < 0 ? assembled.messages.length : systemEnd,
    );

    const result = await compact({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      providerId: prepared.providerId,
      modelId: prepared.modelId,
      usageRecorder: deps.usageRecorder,
      messages,
      systemMessages,
      // 复用 Turn 已确定的 Tool 定义和 thinking, 不为摘要重新选择执行环境.
      tools: assembled.tools,
      ...(prepared.thinking ? { thinking: prepared.thinking } : {}),
      estimatedInputTokens: assembled.usage.estimatedInputTokens,
      ...(recoveryReason === 'context_window_exceeded' ? { force: true } : {}),
      contextWindow: prepared.contextWindow,
      modelMaxOutput: prepared.maxOutput,
      signal: deps.signal,
      // Compact 事件是 Session 域事实; 进入本 Turn 事件流时在此补上 Turn 身份.
      emit: event => {
        deps.emit({ ...event, turnId: deps.turnId });
      },
      settings: prepared.compactSettings,
      // Compact 在保存成功后才发 completed. 游标取被摘要前缀中最后一条
      // 已落库消息, 不把没有对应存储记录的位置作为覆盖边界.
      ...(macroPersistence
        ? {
            saveMacroSummary: (summary: string, summarizedMessageCount: number, savedTokens: number) => {
              const throughMessageId = macroPersistence.messageIds.lastSavedIdInPrefix(summarizedMessageCount);
              if (!throughMessageId) {
                throw new Error('Macro 摘要覆盖范围内没有已落库的 Message');
              }
              const summaryMessage = macroPersistence.appendSummary(summary, throughMessageId, savedTokens);
              macroPersistence.messageIds.replacePrefixWithSummary(summarizedMessageCount, summaryMessage.id);
            },
          }
        : {}),
    });

    let nextMessages = messages;
    if (result.kind !== 'unchanged') {
      nextMessages = result.messages;
      assembled = assemble(nextMessages);
    }
    deps.onContextPrepared?.(llmCallId, assembled.usage);

    return {
      request: {
        messages: assembled.messages,
        tools: assembled.tools,
        ...(prepared.thinking ? { thinking: prepared.thinking } : {}),
        // 输出上限直接取模型行 maxOutput; 模型行未填时不设上限.
        ...(prepared.maxOutput !== null ? { maxOutputTokens: prepared.maxOutput } : {}),
        signal: deps.signal,
      },
      messages: nextMessages,
    };
  };
}
