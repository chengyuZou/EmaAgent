// 实现 agent PrepareAgentIteration 的根 Turn 装配：assemble → 超限则 compact → 落摘要 → 再 assemble。
import type { AgentBudget, PrepareAgentIteration } from '@ema-agent/agent';
import type { CompactRequest, CompactResult } from '@ema-agent/compact';
import {
  assembleContext,
  type PreparedContext,
} from '@ema-agent/context';
import type { Message } from '@ema-agent/llm';
import type { SessionStore } from '@ema-agent/session';
import type { TurnStreamEvent } from '../events.js';
import type { PreparedTurn } from '../preparation/prepareTurn.js';

export interface PrepareLlmCallDeps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prepared: PreparedTurn;
  readonly compact: (request: CompactRequest) => Promise<CompactResult>;
  readonly sessions: Pick<SessionStore, 'appendMessage'>;
  readonly emit: (event: TurnStreamEvent) => void;
  readonly budget: AgentBudget;
  /** 初始工作历史中属于"历史区间"的条数（其后为本 Turn 工作消息）。 */
  readonly baselineMessageCount: number;
  readonly signal: AbortSignal;
  /** 根 Turn true（Macro 摘要落 Session）；子 Agent false——只能压缩自己的工作历史。 */
  readonly persistMacro?: boolean;
  /** 每次请求装配完成后回调；根 Turn 用它更新 fork 子 Agent 的继承视图。 */
  readonly onRequestPrepared?: (messages: readonly Message[]) => void;
}

/**
 * 每次模型调用前重建可见窗口：历史区间（唯一允许 Compact 改写）与本 Turn 工作消息
 * 分开处理；micro/macro 改写后整体替换循环的工作历史并重设基线，Macro 摘要本身即
 * 覆盖游标（历史重放永远从最新 summary 之后开始）。
 *
 * Reminder 不在此重建：它表示"本 Turn 开始时的事实"，由 Turn 在启动前持久化一次，
 * 随本 Turn 工作消息（不可压缩区间）原样到达每一次装配。
 */
export function createPrepareLlmCall(deps: PrepareLlmCallDeps): PrepareAgentIteration {
  const { prepared } = deps;
  let baselineCount = deps.baselineMessageCount;

  return async ({ messages, recoveryReason }) => {
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

    const result = await deps.compact({
      sessionId: deps.sessionId,
      turnId: deps.turnId,
      executionProfile: prepared.executionProfile,
      history,
      estimatedInputTokens: assembled.usage.estimatedInputTokens,
      ...(recoveryReason === 'context_window_exceeded' ? { force: true } : {}),
      contextWindow: prepared.contextWindow,
      maxOutputTokens,
      signal: deps.signal,
      emit: deps.emit,
      settings: prepared.compactSettings,
    });

    let nextMessages = messages;
    if (result.kind !== 'unchanged') {
      if (result.kind === 'macro' && deps.persistMacro !== false) {
        deps.sessions.appendMessage({
          turnId: null,
          sessionId: deps.sessionId,
          role: 'user',
          kind: 'summary',
          blocks: result.summary,
        });
      }
      baselineCount = result.history.length;
      nextMessages = [...result.history, ...currentTurn];
      assembled = assemble(result.history);
    }

    deps.onRequestPrepared?.(assembled.messages);

    return {
      request: {
        messages: assembled.messages,
        tools: assembled.tools,
        ...(prepared.thinkingEnabled ? { thinking: { enabled: true as const } } : {}),
        maxOutputTokens,
        signal: deps.signal,
      },
      messages: nextMessages,
    };
  };
}
