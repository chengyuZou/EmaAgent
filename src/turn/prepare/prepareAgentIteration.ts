// 每次 Agent 模型调用前装配完整消息, 按需压缩, 并保存根 Turn 的摘要.
import type { PrepareAgentIteration } from '@ema-agent/agent';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import {
  assembleContext,
  type ContextUsageEstimate,
  type PreparedContext,
} from '@ema-agent/context';
import type { Message } from '@ema-agent/llm';
import type { SessionStore } from '@ema-agent/session';
import { recordLlmCallUsage, type UsageRecorder } from '@ema-agent/usage';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from './prepareTurn.js';

export interface PrepareAgentIterationDeps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prepared: PreparedTurn;
  readonly compact: (request: CompactRequest) => Promise<CompactResult>;
  readonly emit: (event: TurnStreamEvent) => void;
  /** 摘要调用记账; 缺省不记账(观测不阻断主链). */
  readonly usageRecorder?: UsageRecorder;
  /**
   * 根 Turn 的 Macro 持久化能力. messageIds 与 AgentLoop 消息一一对应;
   * 未落库的引导消息占一个 undefined 位置. 子 Agent 不提供, 因此不写根 Session.
   */
  readonly macroPersistence?: {
    readonly sessions: Pick<SessionStore, 'appendHistorySummary'>;
    readonly messageIds: (string | undefined)[];
  };
  readonly signal: AbortSignal;
  /** 根 Agent 的最终请求装配完成后发布; 子 Agent 省略, 因此不会更新 Session Context. */
  readonly onContextPrepared?: (
    llmCallId: string,
    estimate: ContextUsageEstimate,
  ) => void;
}

/**
 * 历史, reminder 与本 Turn 消息是同一个可压缩数组. Macro 用被覆盖前缀的
 * 最后一条已落库消息作为 SQL 游标; 模型专用引导没有 SQL 行, 不能当游标.
 */
export function createPrepareAgentIteration(deps: PrepareAgentIterationDeps): PrepareAgentIteration {
  const { prepared, macroPersistence } = deps;

  return async ({ llmCallId, messages, recoveryReason }) => {
    const assemble = (currentMessages: readonly Message[]): PreparedContext =>
      assembleContext({
        systemPrompt: prepared.systemPrompt,
        toolPool: prepared.tools.toolPool,
        messages: currentMessages,
        contextWindow: prepared.contextWindow,
      });

    let assembled = assemble(messages);
    // 摘要请求复用本轮装配的系统消息段(同字节, 含缓存断点), 与主对话共享 KV 前缀.
    const systemEnd = assembled.messages.findIndex(message => message.role !== 'system');
    const systemMessages = assembled.messages.slice(
      0,
      systemEnd < 0 ? assembled.messages.length : systemEnd,
    );

    let compactId: string | undefined;
    let compactDurationMs = 0;
    const result = await deps.compact({
      sessionId: deps.sessionId,
      sessionMode: prepared.sessionMode,
      messages,
      systemMessages,
      // 摘要请求复用根 Turn 冻结的 Tool 定义与 thinking 配置, 保持与主请求一致的缓存前缀.
      tools: assembled.tools,
      ...(prepared.thinking ? { thinking: prepared.thinking } : {}),
      estimatedInputTokens: assembled.usage.estimatedInputTokens,
      ...(recoveryReason === 'context_window_exceeded' ? { force: true } : {}),
      contextWindow: prepared.contextWindow,
      modelMaxOutput: prepared.maxOutput,
      signal: deps.signal,
      // Compact 事件是 Session 域事实; 进入本 Turn 事件流时在此补上 Turn 身份.
      emit: event => {
        if (event.type === 'compact_started') compactId = event.compactId;
        if (event.type === 'compact_completed') compactDurationMs = event.durationMs;
        deps.emit({ ...event, turnId: deps.turnId });
      },
      settings: prepared.compactSettings,
      // Compact 在保存成功后才发 completed. 游标取被摘要前缀中最后一条
      // 已落库消息, 跳过没有 SQL 身份的续写和 stuck 引导.
      ...(macroPersistence
        ? {
            saveMacroSummary: (summary: string, summarizedMessageCount: number) => {
              let throughMessageId: string | undefined;
              for (let index = summarizedMessageCount - 1; index >= 0; index -= 1) {
                const id = macroPersistence.messageIds[index];
                if (id === undefined) continue;
                throughMessageId = id;
                break;
              }
              if (!throughMessageId) {
                throw new Error('Macro 摘要覆盖范围内没有已落库的 Session Message');
              }
              const summaryMessage = macroPersistence.sessions.appendHistorySummary({
                sessionId: deps.sessionId,
                turnId: deps.turnId,
                summary,
                summarizedThroughMessageId: throughMessageId,
              });
              macroPersistence.messageIds.splice(0, summarizedMessageCount, summaryMessage.id);
            },
          }
        : {}),
    });

    let nextMessages = messages;
    if (result.kind !== 'unchanged') {
      nextMessages = result.messages;
      assembled = assemble(nextMessages);
    }
    if (result.kind === 'macro') {
      // 摘要调用的 usage 随完成结果带出; 只在成功时入账(abort/失败无 completion),
      // 与主调用共用同一本账(recordLlmCallUsage).
      recordLlmCallUsage(deps.usageRecorder, {
        providerId: prepared.providerId,
        modelId: prepared.modelId,
        status: 'completed',
        startedAt: Date.now() - compactDurationMs,
        durationMs: compactDurationMs,
        usage: result.usage,
        usageContext: {
          callId: compactId ?? `compact:${deps.turnId}`,
          sessionId: deps.sessionId,
          turnId: deps.turnId,
        },
      });
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
