// 实现 agent PrepareAgentIteration 的根 Turn 装配：assemble → 超限则 compact → 落摘要 → 再 assemble。
import type { AgentBudget, PrepareAgentIteration } from '@ema-agent/agent';
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
import type { PreparedTurn } from '../preparation/prepareTurn.js';

export interface PrepareLlmCallDeps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prepared: PreparedTurn;
  readonly compact: (request: CompactRequest) => Promise<CompactResult>;
  readonly emit: (event: TurnStreamEvent) => void;
  readonly budget: AgentBudget;
  /** 摘要调用记账；缺省不记账（观测不阻断主链）。 */
  readonly usageRecorder?: UsageRecorder;
  /** 初始工作历史中属于"历史区间"的条数（其后为本 Turn 工作消息）。 */
  readonly baselineMessageCount: number;
  /**
   * 根 Turn 的 Macro 持久化能力；缺省（子 Agent）表示只压缩自己的工作历史，
   * 不碰根 Session 的 Summary 边界。baselineMessageIds 与历史区间一一对应，
   * 长度必须等于 baselineMessageCount。
   */
  readonly macroPersistence?: {
    readonly sessions: Pick<SessionStore, 'appendHistorySummary'>;
    readonly baselineMessageIds: readonly string[];
  };
  readonly signal: AbortSignal;
  /** 根 Agent 的最终请求装配完成后发布；子 Agent 省略，因此不会更新 Session Context。 */
  readonly onContextPrepared?: (
    llmCallId: string,
    estimate: ContextUsageEstimate,
  ) => void;
  /** 每次准备完成后回调；只暴露 AgentLoop 工作消息，不含 System 与请求级缓存标记。 */
  readonly onWorkingMessagesPrepared?: (messages: readonly Message[]) => void;
}

/**
 * 每次模型调用前重建可见窗口：历史区间（唯一允许 Compact 改写）与本 Turn 工作消息
 * 分开处理；micro/macro 改写后整体替换循环的工作历史并重设基线。Macro 摘要经
 * appendHistorySummary 携带明确覆盖截止游标（summarizedMessageCount 映射自基线身份），
 * 历史重放从游标之后开始，与摘要写入时序无关。
 *
 * Reminder 不在此重建：它表示"本 Turn 开始时的事实"，由 Turn 在启动前持久化一次，
 * 随本 Turn 工作消息（不可压缩区间）原样到达每一次装配。
 */
export function createPrepareLlmCall(deps: PrepareLlmCallDeps): PrepareAgentIteration {
  const { prepared, macroPersistence } = deps;
  let baselineCount = deps.baselineMessageCount;
  if (macroPersistence && macroPersistence.baselineMessageIds.length !== baselineCount) {
    throw new Error('macroPersistence.baselineMessageIds 必须与 baselineMessageCount 等长');
  }
  let baselineIds: readonly string[] = macroPersistence?.baselineMessageIds ?? [];

  return async ({ llmCallId, messages, recoveryReason }) => {
    const history = messages.slice(0, baselineCount);
    const currentTurn = messages.slice(baselineCount);

    const maxOutputTokens = prepared.maxOutput !== null
      ? Math.min(deps.budget.remainingOutputTokens(), prepared.maxOutput)
      : deps.budget.remainingOutputTokens();

    const assemble = (historyPart: readonly Message[]): PreparedContext =>
      assembleContext({
        systemPrompt: prepared.systemPrompt,
        toolPool: prepared.tools.toolPool,
        history: historyPart,
        currentTurn,
        contextWindow: prepared.contextWindow,
      });

    let assembled = assemble(history);
    // 摘要请求复用本轮装配的系统消息段（同字节、含缓存断点），与主对话共享 KV 前缀。
    const systemEnd = assembled.messages.findIndex(message => message.role !== 'system');
    const systemMessages = assembled.messages.slice(
      0,
      systemEnd < 0 ? assembled.messages.length : systemEnd,
    );

    let compactId: string | undefined;
    let compactDurationMs = 0;
    const result = await deps.compact({
      sessionId: deps.sessionId,
      executionProfile: prepared.executionProfile,
      history,
      systemMessages,
      // 摘要请求复用根 Turn 冻结的 Tool 定义与 thinking 配置，保持与主请求一致的缓存前缀。
      tools: assembled.tools,
      ...(prepared.thinking ? { thinking: prepared.thinking } : {}),
      estimatedInputTokens: assembled.usage.estimatedInputTokens,
      ...(recoveryReason === 'context_window_exceeded' ? { force: true } : {}),
      contextWindow: prepared.contextWindow,
      modelMaxOutput: prepared.maxOutput,
      signal: deps.signal,
      // Compact 事件是 Session 域事实；进入本 Turn 事件流时在此补上 Turn 身份。
      emit: event => {
        if (event.type === 'compact_started') compactId = event.compactId;
        if (event.type === 'compact_completed') compactDurationMs = event.durationMs;
        deps.emit({ ...event, turnId: deps.turnId });
      },
      settings: prepared.compactSettings,
      // Macro 摘要由 Compact 在保存成功后发 completed；根 Turn 在此落库
      // （/compact Command 复用同一闭包语义，子 Agent 不提供）。
      ...(macroPersistence
        ? {
            saveMacroSummary: (summary: string, summarizedMessageCount: number) => {
              // 先映射游标再落库；SQL 成功后才让 Compact 发 compact_completed。
              const throughMessageId = baselineIds[summarizedMessageCount - 1]!;
              const summaryMessage = macroPersistence.sessions.appendHistorySummary({
                sessionId: deps.sessionId,
                summary,
                summarizedThroughMessageId: throughMessageId,
              });
              // 新基线 = [持久化的 summary, ...未被摘要的尾部身份]，供本 Turn 可能的再次压缩。
              baselineIds = [
                summaryMessage.id,
                ...baselineIds.slice(summarizedMessageCount),
              ];
            },
          }
        : {}),
    });

    let nextMessages = messages;
    if (result.kind !== 'unchanged') {
      baselineCount = result.history.length;
      nextMessages = [...result.history, ...currentTurn];
      assembled = assemble(result.history);
    }
    if (result.kind === 'macro') {
      // 摘要调用的 usage 随完成结果带出；只在成功时入账（abort/失败无 completion），
      // 与主调用共用同一本账（recordLlmCallUsage）。
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

    deps.onWorkingMessagesPrepared?.(nextMessages);
    deps.onContextPrepared?.(llmCallId, assembled.usage);

    return {
      request: {
        messages: assembled.messages,
        tools: assembled.tools,
        ...(prepared.thinking ? { thinking: prepared.thinking } : {}),
        maxOutputTokens,
        signal: deps.signal,
      },
      messages: nextMessages,
    };
  };
}
