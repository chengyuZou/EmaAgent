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
  ToolExecutionResult,
  ToolExecutionRuntime,
} from '@ema-agent/tools';
import {
  advanceLlmUsageSnapshot,
  ContextWindowExceededError,
} from '@ema-agent/llm';
import { computePromptPrefixHash, normalizeToolDefinitions } from '@ema-agent/context';
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
}) => ToolExecutionRuntime;

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
}

export type PrepareLlmCallResult =
  | { kind: 'continue'; messages: ModelMessage[] }
  | { kind: 'abort'; reason: string };

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
  /**
   * 每个逻辑 LLM 调用前执行的窄回调。AgentLoop 不依赖 HookBus；外层 Runtime
   * 用它触发 beforeLlm，并返回只属于本次请求的消息视图。
   */
  prepareLlmCall?: (input: PrepareLlmCallInput) => Promise<PrepareLlmCallResult>;
  thinking?: ThinkingMode;
}

/** 运行纯粹的思考与行动循环，不拥有 Session 生命周期、HookBus 或传输协议。 */
export async function* runAgentLoop<TExecutorEvent>(
  input: AgentLoopInput<TExecutorEvent>,
): AsyncGenerator<AgentLoopEvent<TExecutorEvent>, AgentLoopOutcome> {
  const {
    messages, policy, llm, providerId, model, signal, maxIterations, budget,
    sessionId, turnId, getScratchpadContext, getMailboxMessages,
    assembleContext,
    prepareLlmCall, thinking,
  } = input;

  const pendingRelayEvents: TExecutorEvent[] = [];
  let wakeUp: (() => void) | null = null;
  const signalWake = (): void => { wakeUp?.(); wakeUp = null; };

  const executor = input.buildExecutor({
    pushEv: (ev: TExecutorEvent) => { pendingRelayEvents.push(ev); signalWake(); },
    signal: signalWake,
  });

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

    state = advanceAgentLoopState(state, {
      phase:      'thinking',
      transition: state.iteration === 0 ? 'initial' : 'next_turn',
      iteration:  state.iteration + 1,
      // 新迭代必须重置只对单轮有效的恢复标记。
      maxOutputTokensRecoveryCount:
        state.transition === 'max_output_tokens_recovery'
          ? state.maxOutputTokensRecoveryCount
          : 0,
      hasAttemptedReactiveCompact:  false,
    });
    yield { type: 'loop_iteration', n: state.iteration, state };

    executor.reset();

    // ── 思考阶段：读取一次模型流 ─────────────────────────────────────────────
    const textByIndex     = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const thinkingSignatureByIndex = new Map<number, string>();
    const completedThinkingIndexes = new Set<number>();
    const toolUseByIndex  = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    // Skill 调用可能收窄后续工具范围，因此每轮都重新取得工具定义。
    // 工具定义虽然不在消息数组中，压缩时仍必须预留其序列化后的 Token 成本。
    let tools = normalizeToolDefinitions(policy.toolDefs());

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
      });
      historyMessages = [...snapshot.history];
      requestMessages = [...snapshot.messages];
      tools = [...snapshot.tools];
    } else {
      requestMessages = buildEffectiveMessages();
    }
    if (prepareLlmCall) {
      const prepared = await prepareLlmCall({
        iteration: state.iteration,
        llmCallId,
        messages: requestMessages,
      });
      if (prepared.kind === 'abort') {
        state = advanceAgentLoopState(state, { phase: 'aborted', transition: 'hook_abort' });
        yield { type: 'loop_hook_abort', reason: prepared.reason };
        return { fullText: '', state };
      }
      requestMessages = prepared.messages;
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
          });
          historyMessages = [...snapshot.history];
          requestMessages = [...snapshot.messages];
          tools = [...snapshot.tools];
          // 新快照不是第一次请求的同一份输入，必须重新经过最终请求 Hook。
          // 使用相同 llmCallId 表明它仍是同一次逻辑调用的 Provider 重试。
          if (prepareLlmCall) {
            const prepared = await prepareLlmCall({
              iteration: state.iteration,
              llmCallId,
              messages: requestMessages,
            });
            if (prepared.kind === 'abort') {
              state = advanceAgentLoopState(state, { phase: 'aborted', transition: 'hook_abort' });
              yield { type: 'loop_hook_abort', reason: prepared.reason };
              return { fullText: '', state };
            }
            requestMessages = prepared.messages;
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

    // 通知外层模型流已结束，以便刷新情绪解析并触发完成 Hook。
    yield {
      type: 'loop_llm_complete',
      iteration: state.iteration,
      llmCallId,
      usage: callUsage,
      promptPrefixHash,
    };

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

    while (!executor.allDone() || pendingRelayEvents.length > 0) {
      while (pendingRelayEvents.length > 0) {
        yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
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

    const resultBlocks: ToolExecutionResult[] = executor.getResults();

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

    // 外层 Runtime 收到后负责持久化 Tool Use 与 Tool Result。
    yield { type: 'loop_tool_results', results: resultBlocks, fullText };

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
