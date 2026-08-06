// 执行一次 AgentRun 内的模型与工具迭代，并返回唯一循环结果。
import { randomUUID } from 'node:crypto';
import { asLlmCallId } from '@ema-agent/llm';
import type {
  AssistantBlock,
  LanguageModel,
  LlmCallId,
  LlmTokenUsage,
  Message as ModelMessage,
  StopReason,
  ThinkingMode,
  UserBlock,
} from '@ema-agent/llm';
import type {
  ToolPool,
  ToolResult,
  StreamingToolExecutor,
} from '@ema-agent/tools';
import {
  advanceLlmUsageSnapshot,
  ContextWindowExceededError,
} from '@ema-agent/llm';
import {
  computePromptPrefixHash,
  normalizeToolDefinitions,
  projectToolPool,
} from '@ema-agent/context';
import type { ModelContextSnapshot } from '@ema-agent/context';
import type { TurnPolicy } from './policy.js';
import {
  advanceAgentLoopState,
  addUsage,
  createAgentLoopState,
} from './agentLoopState.js';
import type { AgentLoopState } from './agentLoopState.js';
import type { AgentLoopEvent } from './events.js';
import type { TurnBudget } from './turn-budget.js';

const MAX_CONSECUTIVE_PERMISSION_DENIALS = 3;
const MAX_TOTAL_PERMISSION_DENIALS = 20;

export interface AgentLoopOutcome {
  fullText: string;
  state: AgentLoopState;
}

// ── AgentLoop 输入 ────────────────────────────────────────────────────────────

/**
 * AgentLoop 提供唤醒和事件回调，外层注入本次执行所需的工具依赖。
 */
export type ExecutorFactory<TExecutorEvent> = (internals: {
  /** 接收执行器产生的领域事件。 */
  pushEv:  (ev: TExecutorEvent) => void;
  /** 工具完成时唤醒等待队列。 */
  signal:  () => void;
  /** 与本次模型请求共享的冻结 ToolPool。 */
  toolPool: ToolPool;
}) => StreamingToolExecutor;

export interface PrepareLlmCallInput {
  iteration: number;
  llmCallId: LlmCallId;
  messages: ModelMessage[];
}

export interface AssembleAgentContextInput {
  history: readonly ModelMessage[];
  currentTurn: readonly ModelMessage[];
  scratchpadContext?: string;
  mailboxMessages: readonly string[];
  forceCompaction: boolean;
  /** 本轮模型可见且执行器真正可调用的同一个冻结 ToolPool。 */
  toolPool: ToolPool;
}

export interface AgentLoopInput<TExecutorEvent> {
  /** 初始持久化历史与当前用户消息；启用上下文装配后会建立独立工作副本。 */
  messages:       ModelMessage[];
  /** messages 中属于已持久化 Session 历史的前缀长度。 */
  historyMessageCount?: number;
  policy:         TurnPolicy;
  /** 循环建立时创建本次工具执行器。 */
  buildExecutor:  ExecutorFactory<TExecutorEvent>;
  llm:            LanguageModel;
  providerId:     string;
  model:          string;
  signal:         AbortSignal;
  maxIterations:  number;
  /** 主 Agent 与全部 Subagent 共享的原子资源预算。 */
  budget:         TurnBudget;
  sessionId:      string;
  turnId?:        string;
  /** 每次模型调用前读取当前 Scratchpad，并作为不持久化的临时消息注入。 */
  getScratchpadContext?: () => string | undefined;
  /** 原子取出子 Agent 邮箱消息；每条消息只在下一次模型调用中出现一次。 */
  getMailboxMessages?: () => string[];
  /** 每轮 LLM 调用前生成不可变请求快照；Provider 报上下文超限时以 forceCompaction 再生成一次。 */
  assembleContext?: (
    input: AssembleAgentContextInput,
  ) => Promise<ModelContextSnapshot>;
  /** 每次最终请求快照确定后通知外层，用于更新子 Agent 继承视图与诊断。 */
  onLlmRequestPrepared?: (input: PrepareLlmCallInput) => void | Promise<void>;
  thinking?: ThinkingMode;
}

/** 运行纯粹的思考与行动循环，不拥有 Session 生命周期或传输协议。 */
export async function* runAgentLoop<TExecutorEvent>(
  input: AgentLoopInput<TExecutorEvent>,
): AsyncGenerator<AgentLoopEvent<TExecutorEvent>, AgentLoopOutcome> {
  const {
    messages, policy, llm, providerId, model, signal, maxIterations, budget,
    sessionId, turnId, getScratchpadContext, getMailboxMessages,
    assembleContext,
    onLlmRequestPrepared, thinking,
  } = input;

  const pendingRelayEvents: TExecutorEvent[] = [];
  let wakeUp: (() => void) | null = null;
  const signalWake = (): void => { wakeUp?.(); wakeUp = null; };

  let state = createAgentLoopState();
  let historyMessages = assembleContext
    ? messages.slice(0, input.historyMessageCount ?? 0)
    : [];
  const turnMessages = assembleContext
    ? messages.slice(input.historyMessageCount ?? 0)
    : messages;
  let consecutivePermissionDenials = 0;
  let totalPermissionDenials = 0;

  while (true) {
    budget.assertWithinLimits();
    if (signal.aborted) {
      state = advanceAgentLoopState(state, { phase: 'aborted', transition: 'user_abort' });
      return { fullText: '', state };
    }

    const continuesOutput = state.transition === 'max_output_tokens_recovery';
    state = advanceAgentLoopState(state, {
      phase:      'thinking',
      transition: state.iteration === 0 ? 'initial' : 'next_turn',
      iteration:  state.iteration + 1,
      // 新迭代必须重置只对单轮有效的恢复标记。
      maxOutputTokensRecoveryCount:
        continuesOutput
          ? state.maxOutputTokensRecoveryCount
          : 0,
      hasAttemptedReactiveCompact:  false,
    });
    yield {
      type: 'loop_iteration',
      n: state.iteration,
      state,
      continuesOutput,
    };

    // Skill 只能在工具轮结束后影响下一次模型请求。每轮取得一次当前 Pool，并把
    // 同一个对象交给 Context 和执行器，避免模型可见工具与实际准入分叉。
    const toolPool = policy.toolPool();
    const executor = input.buildExecutor({
      pushEv: (ev: TExecutorEvent) => { pendingRelayEvents.push(ev); signalWake(); },
      signal: signalWake,
      toolPool,
    });

    // ── 思考阶段：读取一次模型流 ─────────────────────────────────────────────
    const textByIndex     = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const thinkingSignatureByIndex = new Map<number, string>();
    const completedThinkingIndexes = new Set<number>();
    const toolUseByIndex  = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    // Skill 调用可能收窄后续工具范围，因此每轮都重新取得工具定义。
    // 工具定义虽然不在消息数组中，压缩时仍必须预留其序列化后的 Token 成本。
    let tools = normalizeToolDefinitions(projectToolPool(toolPool));

    // Scratchpad 和邮箱只进入本次请求视图，不写回持久消息。
    const scratchpadCtx  = getScratchpadContext?.();
    const mailboxMsgs    = getMailboxMessages?.() ?? [];

    const buildEffectiveMessages = (): ModelMessage[] => [
      ...turnMessages,
      ...(scratchpadCtx ? [{ role: 'user' as const, content: scratchpadCtx }] : []),
      ...mailboxMsgs.map(m => ({ role: 'user' as const, content: `[Coordinator]: ${m}` })),
    ];

    const llmCallId = asLlmCallId(randomUUID());
    let requestMessages: ModelMessage[];
    if (assembleContext) {
      const snapshot = await assembleContext({
        history: [...historyMessages],
        currentTurn: [...turnMessages],
        ...(scratchpadCtx ? { scratchpadContext: scratchpadCtx } : {}),
        mailboxMessages: mailboxMsgs,
        forceCompaction: false,
        toolPool,
      });
      historyMessages = [...snapshot.history];
      requestMessages = [...snapshot.messages];
      tools = [...snapshot.tools];
    } else {
      requestMessages = buildEffectiveMessages();
    }
    if (onLlmRequestPrepared) {
      await onLlmRequestPrepared({
        iteration: state.iteration,
        llmCallId,
        messages: requestMessages,
      });
    }

    let lastStopReason: StopReason = 'end_turn';
    let callUsage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let promptPrefixHash: string | null = null;

    // 内层只处理一次上下文超限后的响应式压缩重试。
    let streamRetry = false;
    do {
      streamRetry = false;
      textByIndex.clear();
      thinkingByIndex.clear();
      thinkingSignatureByIndex.clear();
      completedThinkingIndexes.clear();
      toolUseByIndex.clear();
      lastStopReason = 'end_turn';
      callUsage = { inputTokens: 0, outputTokens: 0 };
      promptPrefixHash = computePromptPrefixHash({ messages: requestMessages, tools });

      const stream = llm.stream({
        providerId, model,
        messages:   requestMessages,
        tools,
        toolChoice: 'auto',
        thinking,
        maxTokens: budget.remainingOutputTokens(),
        signal,
        usageContext: {
          callId: llmCallId,
          sessionId,
          turnId,
        },
      });

      try {
        for await (const chunk of stream) {
          budget.assertWithinLimits();
          // 工具可能并发完成，因此每个模型分片之间都排空执行器事件。
          while (pendingRelayEvents.length > 0) {
            yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
          }

          switch (chunk.type) {
            case 'request_degraded':
              yield {
                type: 'loop_request_degraded',
                attempt: chunk.attempt,
                reason: chunk.reason,
                removed: chunk.removed,
                replacements: chunk.replacements,
              };
              break;
            case 'text_delta':
              textByIndex.set(chunk.blockIndex, (textByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
              yield { type: 'loop_text_delta', delta: chunk.delta, blockIndex: chunk.blockIndex };
              break;

            case 'thinking_delta':
              thinkingByIndex.set(chunk.blockIndex, (thinkingByIndex.get(chunk.blockIndex) ?? '') + chunk.delta);
              yield { type: 'loop_thinking_delta', delta: chunk.delta, blockIndex: chunk.blockIndex };
              break;

            case 'thinking_complete':
              thinkingSignatureByIndex.set(chunk.blockIndex, chunk.signature);
              completedThinkingIndexes.add(chunk.blockIndex);
              yield {
                type: 'loop_thinking_complete',
                blockIndex: chunk.blockIndex,
                signature: chunk.signature,
              };
              break;

            case 'tool_use_delta':
              yield { type: 'loop_tool_partial', callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta, blockIndex: chunk.blockIndex };
              break;

            case 'tool_use_complete':
              budget.reserveToolCall();
              toolUseByIndex.set(chunk.blockIndex, {
                type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args,
              });
              yield { type: 'loop_tool_complete', callId: chunk.callId, name: chunk.name, args: chunk.args, blockIndex: chunk.blockIndex };
              // 工具调用完整后立即派发；执行器自行决定哪些调用可以并行。
              executor.addTool(chunk.blockIndex, chunk.callId, chunk.name, chunk.args);
              break;

            case 'usage': {
              const incomingUsage: LlmTokenUsage = {
                inputTokens: chunk.inputTokens,
                outputTokens: chunk.outputTokens,
                ...(chunk.cacheReadInputTokens !== undefined
                  ? { cacheReadInputTokens: chunk.cacheReadInputTokens }
                  : {}),
                ...(chunk.cacheWriteInputTokens !== undefined
                  ? { cacheWriteInputTokens: chunk.cacheWriteInputTokens }
                  : {}),
                ...(chunk.cacheHitRate !== undefined ? { cacheHitRate: chunk.cacheHitRate } : {}),
              };
              const advanced = advanceLlmUsageSnapshot(callUsage, incomingUsage);
              callUsage = advanced.snapshot;
              const hasNewUsage = advanced.delta.inputTokens > 0
                || advanced.delta.outputTokens > 0
                || (advanced.delta.cacheReadInputTokens ?? 0) > 0
                || (advanced.delta.cacheWriteInputTokens ?? 0) > 0;
              if (hasNewUsage) {
                budget.recordUsage(advanced.delta);
                state = addUsage(state, advanced.delta);
                yield { type: 'loop_usage', usage: state.usage };
              }
              break;
            }

            case 'done':
              lastStopReason = chunk.stopReason;
              break;
          }
        }
      } catch (err) {
        // 上下文超限时强制压缩一次，并用同一逻辑调用身份重试。
        if (
          err instanceof ContextWindowExceededError &&
          assembleContext &&
          !state.hasAttemptedReactiveCompact
        ) {
          const snapshot = await assembleContext({
            history: [...historyMessages],
            currentTurn: [...turnMessages],
            ...(scratchpadCtx ? { scratchpadContext: scratchpadCtx } : {}),
            mailboxMessages: mailboxMsgs,
            forceCompaction: true,
            toolPool,
          });
          historyMessages = [...snapshot.history];
          requestMessages = [...snapshot.messages];
          tools = [...snapshot.tools];
          // 新快照属于同一次逻辑调用的 Provider 重试，继续使用相同 llmCallId。
          if (onLlmRequestPrepared) {
            await onLlmRequestPrepared({
              iteration: state.iteration,
              llmCallId,
              messages: requestMessages,
            });
          }
          state = advanceAgentLoopState(state, {
            phase:                       state.phase,
            hasAttemptedReactiveCompact: true,
            transition:                  'reactive_compact',
          });
          streamRetry = true;
          continue;
        }
        throw err;
      }
    } while (streamRetry);

    const fullText = [...textByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .join('');

    for (const blockIndex of thinkingByIndex.keys()) {
      if (completedThinkingIndexes.has(blockIndex)) continue;
      completedThinkingIndexes.add(blockIndex);
      yield { type: 'loop_thinking_complete', blockIndex };
    }

    // 通知外层模型流已结束，以便刷新情绪解析和持久化本轮结果。
    yield {
      type: 'loop_llm_complete',
      iteration: state.iteration,
      llmCallId,
      usage: callUsage,
      promptPrefixHash,
    };

    // 外层处理完 loop_llm_complete 后，assistant 的 tool_use 已持久化。
    // 从这一刻起才允许工具越过副作用边界。
    if (toolUseByIndex.size > 0) executor.start();

    // ── 输出 Token 达上限后的单次续写 ─────────────────────────────────────────
    // Provider 到达本次调用的有效输出预算时，允许自动续写一次。
    // 有效预算由上层决定，并由 LLM 请求准备器按模型最大输出上限裁剪。
    if (lastStopReason === 'max_tokens' && toolUseByIndex.size === 0) {
      if (state.maxOutputTokensRecoveryCount === 0) {
        const partialBlocks = buildBlockMap(
          textByIndex,
          thinkingByIndex,
          thinkingSignatureByIndex,
          new Map(),
        );
        if (partialBlocks.length > 0) {
          turnMessages.push({ role: 'assistant', content: partialBlocks });
        }
        turnMessages.push({ role: 'user', content: '[系统] 你的输出被截断，请从中断处继续输出剩余内容，不要重复已输出的部分。' });
        state = advanceAgentLoopState(state, {
          phase: 'thinking',
          transition: 'max_output_tokens_recovery',
          maxOutputTokensRecoveryCount: 1,
        });
        continue;
      } else {
        // 续写仍被截断时结束，避免无限补写。
        state = advanceAgentLoopState(state, { phase: 'done', transition: 'max_output_tokens_recovery' });
        yield { type: 'loop_breaker', reason: 'max_output_tokens recovery failed' };
        return { fullText, state };
      }
    }

    // 没有工具调用表示本次 AgentRun 已得到最终回答。
    if (toolUseByIndex.size === 0) {
      const blockMap = buildBlockMap(
        textByIndex,
        thinkingByIndex,
        thinkingSignatureByIndex,
        new Map(),
      );
      turnMessages.push({ role: 'assistant', content: blockMap });

      state = advanceAgentLoopState(state, { phase: 'done', transition: 'no_tool_calls' });
      return { fullText, state };
    }

    // ── 行动阶段：等待全部工具并持续排空事件 ─────────────────────────────────
    state = advanceAgentLoopState(state, { phase: 'acting', transition: 'next_turn' });

    const resultBlocks: ToolResult[] = [];
    while (!executor.allDone() || pendingRelayEvents.length > 0) {
      while (pendingRelayEvents.length > 0) {
        yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
      }
      for (const result of executor.takeCompletedResults()) {
        resultBlocks.push(result);
        yield { type: 'loop_tool_result', result };
        executor.acknowledgeResult(result.toolCallId);
      }
      if (executor.allDone()) break;

      // AskUser 未返回期间显式进入等待用户状态。
      if (executor.hasWaitingUserTool() && state.phase !== 'waiting_user') {
        state = advanceAgentLoopState(state, { phase: 'waiting_user', transition: 'waiting_user' });
      } else if (!executor.hasWaitingUserTool() && state.phase === 'waiting_user') {
        state = advanceAgentLoopState(state, { phase: 'acting', transition: 'user_answered' });
      }

      // 必须先安装唤醒回调再复查完成状态，避免最后一个工具恰好在两步之间结束。
      const parked = new Promise<void>(r => { wakeUp = r; });
      if (executor.allDone() || pendingRelayEvents.length > 0) { wakeUp = null; continue; }
      await parked;
    }
    // 等待结束后再排空一次，不能遗漏最后一个工具的终态事件。
    while (pendingRelayEvents.length > 0) {
      yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
    }
    for (const result of executor.takeCompletedResults()) {
      resultBlocks.push(result);
      yield { type: 'loop_tool_result', result };
      executor.acknowledgeResult(result.toolCallId);
    }

    const permissionDenials = resultBlocks.filter(
      result => result.isError && result.errorCode === 'permission/denied',
    ).length;
    totalPermissionDenials += permissionDenials;
    consecutivePermissionDenials =
      resultBlocks.length > 0 && permissionDenials === resultBlocks.length
        ? consecutivePermissionDenials + permissionDenials
        : 0;

    // 把当前工具轮次追加到循环工作消息；thinking 不跨 Provider 重放。
    const allBlocks = buildBlockMap(
      textByIndex,
      thinkingByIndex,
      thinkingSignatureByIndex,
      toolUseByIndex,
    );
    const replayBlocks = allBlocks.filter(b => b.type !== 'thinking');
    turnMessages.push({ role: 'assistant', content: replayBlocks });
    turnMessages.push({ role: 'user', content: resultBlocks as UserBlock[] });

    if (
      consecutivePermissionDenials >= MAX_CONSECUTIVE_PERMISSION_DENIALS ||
      totalPermissionDenials >= MAX_TOTAL_PERMISSION_DENIALS
    ) {
      const reason = totalPermissionDenials >= MAX_TOTAL_PERMISSION_DENIALS
        ? `permission denied ${totalPermissionDenials} times in this turn`
        : `permission denied ${consecutivePermissionDenials} consecutive times`;
      state = advanceAgentLoopState(state, { phase: 'done', transition: 'permission_denial_loop' });
      yield { type: 'loop_breaker', reason };
      return { fullText, state };
    }

    // ── 最大迭代熔断 ─────────────────────────────────────────────────────────
    if (state.iteration >= maxIterations) {
      const reason = `max iterations (${maxIterations}) reached`;
      state = advanceAgentLoopState(state, { phase: 'done', transition: 'max_iterations' });
      yield { type: 'loop_breaker', reason };
      return { fullText, state };
    }
  }
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

function buildBlockMap(
  textByIndex:    Map<number, string>,
  thinkingByIndex:Map<number, string>,
  thinkingSignatureByIndex: Map<number, string>,
  toolUseByIndex: Map<number, AssistantBlock & { type: 'tool_use' }>,
): AssistantBlock[] {
  const blockMap = new Map<number, AssistantBlock>();
  for (const [idx, text]     of textByIndex)     blockMap.set(idx, { type: 'text', text });
  for (const [idx, thinking] of thinkingByIndex) {
    const signature = thinkingSignatureByIndex.get(idx);
    blockMap.set(idx, {
      type: 'thinking',
      thinking,
      ...(signature ? { signature } : {}),
    });
  }
  for (const [idx, b]        of toolUseByIndex)  blockMap.set(idx, b);
  return [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
}

// ── 调用方需要的状态类型 ─────────────────────────────────────────────────────

export type { AgentLoopState };
