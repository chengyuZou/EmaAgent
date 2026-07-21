// 执行 Agent 的多轮模型与工具循环，并维护每轮状态、预算和事件。
import {
  randomUUID } from 'node:crypto';
import type { ToolResultBlock,
} from '@ema-agent/contracts';
import {
  EmaStreamEvent,
} from '@ema-agent/turn';
import { asLlmCallId } from '@ema-agent/llm';
import type {
  AssistantBlock,
  LanguageModel,
  LlmCallId,
  LlmTokenUsage,
  LlmToolDef,
  Message as ModelMessage,
  StopReason,
  ThinkingMode,
  UserBlock,
} from '@ema-agent/llm';
import {
  advanceLlmUsageSnapshot,
  ContextWindowExceededError,
} from '@ema-agent/llm';
import { computePromptPrefixHash, normalizeToolDefinitions } from '@ema-agent/context';
import type { AgentPolicy } from './policy.js';
import type { TurnToolExecutor } from './tool-executor.js';
import { advanceState, addUsage, createLoopState } from './loop-state.js';
import type { LoopState } from './loop-state.js';
import type { TurnBudget } from './turn-budget.js';

const MAX_CONSECUTIVE_PERMISSION_DENIALS = 3;
const MAX_TOTAL_PERMISSION_DENIALS = 20;

// ── AgentLoopEvent — internal, not EmaStreamEvent ────────────────────────────
//
// Loop yields only the events it generates itself.  Tool events (tool_result,
// permission_required, ask_user_required, …) come through two paths:
//
//   loop_relay        — executor event forwarded verbatim; engine yields as-is.
//   loop_llm_complete — LLM stream ended; engine should flush emotion + fire
//                       afterLlmComplete hook.
//   loop_tool_results — all tools finished; engine persists to session DB.
//
// Emotion processing (ACT tag stripping) is intentionally NOT in the loop.
// engine.ts intercepts loop_text_delta and runs emotion.processChunk() before
// yielding output_text_delta to SSE.

export type AgentLoopEvent =
  | { type: 'loop_iteration';     n: number; state: LoopState }
  | { type: 'loop_text_delta';    delta: string; blockIndex: number }
  | { type: 'loop_thinking_delta';delta: string; blockIndex: number }
  | { type: 'loop_tool_partial';  callId: string; name: string; argsDelta: string; blockIndex: number }
  | { type: 'loop_tool_complete'; callId: string; name: string; args: unknown; blockIndex: number }
  | {
      type: 'loop_request_degraded';
      attempt: number;
      reason: string;
      removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
      replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
    }
  | { type: 'loop_relay';         ev: EmaStreamEvent }
  | { type: 'loop_usage';         usage: LlmTokenUsage }
  | {
      type: 'loop_llm_complete';
      iteration: number;
      llmCallId: LlmCallId;
      usage: LlmTokenUsage;
      promptPrefixHash: string | null;
    }
  | { type: 'loop_hook_abort'; reason: string }
  | { type: 'loop_tool_results';  results: ToolResultBlock[]; fullText: string }
  | { type: 'loop_breaker';       reason: string }
  | { type: 'loop_done';          fullText: string; state: LoopState };

// ── AgentLoopInput ────────────────────────────────────────────────────────────

/**
 * Factory called by the loop to build its TurnToolExecutor.
 * The loop provides the internal wakeUp/relay callbacks; the caller bakes in
 * all the session/permission/hook deps it knows about.
 */
export type ExecutorFactory = (internals: {
  /** Called by executor for every event it generates (tool_result, permission_required, …). */
  pushEv:  (ev: EmaStreamEvent) => void;
  /** Called by executor when a tool finishes, so the loop's drain-wait unparks. */
  signal:  () => void;
}) => TurnToolExecutor;

export interface PrepareLlmCallInput {
  iteration: number;
  llmCallId: LlmCallId;
  messages: ModelMessage[];
}

export type PrepareLlmCallResult =
  | { kind: 'continue'; messages: ModelMessage[] }
  | { kind: 'abort'; reason: string };

export interface AgentLoopInput {
  /** Mutable messages array. Loop appends each round's assistant + tool-result messages. */
  messages:       ModelMessage[];
  policy:         AgentPolicy;
  /** Called once at loop construction. Provides the loop's internal relay callbacks. */
  buildExecutor:  ExecutorFactory;
  llm:            LanguageModel;
  providerId:     string;
  model:          string;
  signal:         AbortSignal;
  maxIterations:  number;
  /** 主 Agent 与全部 Subagent 共享的原子资源预算。 */
  budget:         TurnBudget;
  sessionId:      string;
  turnId?:        string;
  /**
   * Called before each LLM call. When it returns a non-empty string, the loop
   * prepends an ephemeral user message containing that string to the messages
   * sent to the LLM — without mutating the persistent messages[].
   * Used to inject current scratchpad state so agents see what sub-agents wrote.
   */
  getScratchpadContext?: () => string | undefined;
  /**
   * Called before each LLM call. Returns any messages queued via
   * subagent_send_message since the last iteration, then atomically clears
   * the queue. Each string is injected as a separate ephemeral user message
   * so the agent sees mid-execution coordinator instructions.
   * Only populated for background sub-agents; always undefined for the main agent.
   */
  getMailboxMessages?: () => string[];
  /**
   * Called at the top of every iteration before the LLM call.
   * Runs compaction on the accumulated messages and returns the (possibly
   * compacted) replacement array. Mutates messages[] in place so subsequent
   * iterations and the spawner both see the compacted history.
   * Engine wires this to ContextCompactor.compact(); spawner omits it (ephemeral).
   */
  compactMessages?: (messages: ModelMessage[], tools: readonly LlmToolDef[]) => Promise<ModelMessage[]>;
  /**
   * 每个逻辑 LLM 调用前执行的窄 Facade。Loop 不依赖 HookBus；主 Engine
   * 用它触发 beforeLlm，并返回只属于本次请求的消息视图。
   */
  prepareLlmCall?: (input: PrepareLlmCallInput) => Promise<PrepareLlmCallResult>;
  thinking?: ThinkingMode;
}

// ── agentLoop ─────────────────────────────────────────────────────────────────

/**
 * Pure think→act loop. No session store, no hook bus, no EmaStreamEvent yield
 * (except as loop_relay wrappers).
 *
 * Callers:
 *   engine.ts   — wraps with session lifecycle + beforeLlm hook + emotion + SSE
 *   spawner.ts  — ephemeral context, collects fullText + usage from loop_done
 *
 * Tool events (executor pushEv) are collected in pendingRelayEvents and yielded
 * as loop_relay between every LLM chunk and during the drain-wait.
 * The TOCTOU-safe park pattern prevents the drain-wait from blocking forever
 * if the last tool finishes between the allDone() check and await.
 */
export async function* agentLoop(input: AgentLoopInput): AsyncIterable<AgentLoopEvent> {
  const {
    messages, policy, llm, providerId, model, signal, maxIterations, budget,
    sessionId, turnId, getScratchpadContext, getMailboxMessages, compactMessages,
    prepareLlmCall, thinking,
  } = input;

  const pendingRelayEvents: EmaStreamEvent[] = [];
  let wakeUp: (() => void) | null = null;
  const signalWake = (): void => { wakeUp?.(); wakeUp = null; };

  const executor = input.buildExecutor({
    pushEv: (ev: EmaStreamEvent) => { pendingRelayEvents.push(ev); signalWake(); },
    signal: signalWake,
  });

  let state = createLoopState();
  let consecutivePermissionDenials = 0;
  let totalPermissionDenials = 0;

  while (true) {
    budget.assertWithinLimits();
    if (signal.aborted) {
      state = advanceState(state, { phase: 'aborted', transition: 'user_abort' });
      yield { type: 'loop_done', fullText: '', state };
      return;
    }

    state = advanceState(state, {
      phase:      'thinking',
      transition: state.iteration === 0 ? 'initial' : 'next_turn',
      iteration:  state.iteration + 1,
      // Reset per-iteration recovery flags on every new iteration.
      maxOutputTokensRecoveryCount:
        state.transition === 'max_output_tokens_recovery'
          ? state.maxOutputTokensRecoveryCount
          : 0,
      hasAttemptedReactiveCompact:  false,
    });
    yield { type: 'loop_iteration', n: state.iteration, state };

    executor.reset();

    // ── THINK: stream one LLM response ──────────────────────────────────────
    const textByIndex     = new Map<number, string>();
    const thinkingByIndex = new Map<number, string>();
    const toolUseByIndex  = new Map<number, AssistantBlock & { type: 'tool_use' }>();

    // Skill 调用可能收窄后续工具范围，因此每轮都重新取得工具定义。
    // 工具定义虽然不在消息数组中，压缩时仍必须预留其序列化后的 Token 成本。
    const tools = normalizeToolDefinitions(policy.toolDefs());

    // Per-iteration compaction: runs before every LLM call so agent loops that
    // accumulate many tool results don't overflow the context window mid-turn.
    // Mutates messages[] in place; spawner omits compactMessages (ephemeral ctx).
    if (compactMessages) {
      const compacted = await compactMessages([...messages], tools);
      messages.splice(0, messages.length, ...compacted);
    }

    // Inject scratchpad context and mailbox messages as ephemeral user messages
    // before each LLM call — not persisted into messages[].
    // Mailbox messages are drained atomically so each is only seen once.
    const scratchpadCtx  = getScratchpadContext?.();
    const mailboxMsgs    = getMailboxMessages?.() ?? [];

    const buildEffectiveMessages = (): ModelMessage[] => [
      ...messages,
      ...(scratchpadCtx ? [{ role: 'user' as const, content: scratchpadCtx }] : []),
      ...mailboxMsgs.map(m => ({ role: 'user' as const, content: `[Coordinator]: ${m}` })),
    ];

    const llmCallId = asLlmCallId(randomUUID());
    let requestMessages = buildEffectiveMessages();
    if (prepareLlmCall) {
      const prepared = await prepareLlmCall({
        iteration: state.iteration,
        llmCallId,
        messages: requestMessages,
      });
      if (prepared.kind === 'abort') {
        state = advanceState(state, { phase: 'aborted', transition: 'hook_abort' });
        yield { type: 'loop_hook_abort', reason: prepared.reason };
        yield { type: 'loop_done', fullText: '', state };
        return;
      }
      requestMessages = prepared.messages;
    }

    let lastStopReason: StopReason = 'end_turn';
    let callUsage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
    let promptPrefixHash: string | null = null;

    // ── Inner retry loop: handles reactive compact on ContextWindowExceededError ──
    let streamRetry = false;
    do {
      streamRetry = false;
      textByIndex.clear();
      thinkingByIndex.clear();
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
          // Drain relay events between LLM chunks — tools may have fired concurrently.
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

            case 'tool_use_delta':
              yield { type: 'loop_tool_partial', callId: chunk.callId, name: chunk.name, argsDelta: chunk.argsDelta, blockIndex: chunk.blockIndex };
              break;

            case 'tool_use_complete':
              budget.reserveToolCall();
              toolUseByIndex.set(chunk.blockIndex, {
                type: 'tool_use', id: chunk.callId, name: chunk.name, args: chunk.args,
              });
              yield { type: 'loop_tool_complete', callId: chunk.callId, name: chunk.name, args: chunk.args, blockIndex: chunk.blockIndex };
              // Start executing immediately — concurrent-safe tools run in parallel.
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
        // ── Reactive compact: prompt too long → compact once and retry ────────
        if (
          err instanceof ContextWindowExceededError &&
          compactMessages &&
          !state.hasAttemptedReactiveCompact
        ) {
          // Hook 链只执行一次。响应式重试压缩本次请求视图，不重复执行
          // Prompt/Memory/Skill 等可能有外部副作用的 beforeLlm handler。
          requestMessages = await compactMessages([...requestMessages], tools);
          state = advanceState(state, {
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

    // Signal LLM stream end — engine flushes emotion + fires afterLlmComplete.
    yield {
      type: 'loop_llm_complete',
      iteration: state.iteration,
      llmCallId,
      usage: callUsage,
      promptPrefixHash,
    };

    // ── max_output_tokens recovery ────────────────────────────────────────────
    // Provider 到达本次调用的有效输出预算时，允许自动续写一次。
    // 有效预算由上层决定，并由 LLM 请求准备器按模型最大输出上限裁剪。
    if (lastStopReason === 'max_tokens' && toolUseByIndex.size === 0) {
      if (state.maxOutputTokensRecoveryCount === 0) {
        const partialBlocks = buildBlockMap(textByIndex, thinkingByIndex, new Map());
        if (partialBlocks.length > 0) {
          messages.push({ role: 'assistant', content: partialBlocks });
        }
        messages.push({ role: 'user', content: '[系统] 你的输出被截断，请从中断处继续输出剩余内容，不要重复已输出的部分。' });
        state = advanceState(state, {
          phase: 'thinking',
          transition: 'max_output_tokens_recovery',
          maxOutputTokensRecoveryCount: 1,
        });
        continue;
      } else {
        // Continuation attempt also truncated — give up.
        state = advanceState(state, { phase: 'done', transition: 'max_output_tokens_recovery' });
        yield { type: 'loop_breaker', reason: 'max_output_tokens recovery failed' };
        yield { type: 'loop_done', fullText, state };
        return;
      }
    }

    // ── End condition: no tool calls → done ──────────────────────────────────
    if (toolUseByIndex.size === 0) {
      const blockMap = buildBlockMap(textByIndex, thinkingByIndex, new Map());
      messages.push({ role: 'assistant', content: blockMap });

      state = advanceState(state, { phase: 'done', transition: 'no_tool_calls' });
      yield { type: 'loop_done', fullText, state };
      return;
    }

    // ── ACT: wait for all tools, draining relay events as they arrive ────────
    state = advanceState(state, { phase: 'acting', transition: 'next_turn' });

    while (!executor.allDone() || pendingRelayEvents.length > 0) {
      while (pendingRelayEvents.length > 0) {
        yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
      }
      if (executor.allDone()) break;

      // Track waiting_user phase when ask_user tool is pending.
      if (executor.hasWaitingUserTool() && state.phase !== 'waiting_user') {
        state = advanceState(state, { phase: 'waiting_user', transition: 'waiting_user' });
      } else if (!executor.hasWaitingUserTool() && state.phase === 'waiting_user') {
        state = advanceState(state, { phase: 'acting', transition: 'user_answered' });
      }

      // Install resolver BEFORE re-checking — avoids TOCTOU deadlock where the
      // last tool finishes between allDone() and the await assignment.
      const parked = new Promise<void>(r => { wakeUp = r; });
      if (executor.allDone() || pendingRelayEvents.length > 0) { wakeUp = null; continue; }
      await parked;
    }
    // Final relay drain after drain-wait exits.
    while (pendingRelayEvents.length > 0) {
      yield { type: 'loop_relay', ev: pendingRelayEvents.shift()! };
    }

    const resultBlocks: ToolResultBlock[] = executor.getResults();

    const permissionDenials = resultBlocks.filter(
      result => result.isError && result.errorCode === 'permission/denied',
    ).length;
    totalPermissionDenials += permissionDenials;
    consecutivePermissionDenials =
      resultBlocks.length > 0 && permissionDenials === resultBlocks.length
        ? consecutivePermissionDenials + permissionDenials
        : 0;

    // Persist round: assistant (tool_use) + user (tool_result) into messages[].
    const allBlocks    = buildBlockMap(textByIndex, thinkingByIndex, toolUseByIndex);
    const replayBlocks = allBlocks.filter(b => b.type !== 'thinking');
    messages.push({ role: 'assistant', content: replayBlocks });
    messages.push({ role: 'user', content: resultBlocks as UserBlock[] });

    // Signal engine to persist tool results to session DB.
    yield { type: 'loop_tool_results', results: resultBlocks, fullText };

    if (
      consecutivePermissionDenials >= MAX_CONSECUTIVE_PERMISSION_DENIALS ||
      totalPermissionDenials >= MAX_TOTAL_PERMISSION_DENIALS
    ) {
      const reason = totalPermissionDenials >= MAX_TOTAL_PERMISSION_DENIALS
        ? `permission denied ${totalPermissionDenials} times in this turn`
        : `permission denied ${consecutivePermissionDenials} consecutive times`;
      state = advanceState(state, { phase: 'done', transition: 'permission_denial_loop' });
      yield { type: 'loop_breaker', reason };
      yield { type: 'loop_done', fullText, state };
      return;
    }

    // ── Circuit breaker ──────────────────────────────────────────────────────
    if (state.iteration >= maxIterations) {
      const reason = `max iterations (${maxIterations}) reached`;
      state = advanceState(state, { phase: 'done', transition: 'max_iterations' });
      yield { type: 'loop_breaker', reason };
      yield { type: 'loop_done', fullText, state };
      return;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildBlockMap(
  textByIndex:    Map<number, string>,
  thinkingByIndex:Map<number, string>,
  toolUseByIndex: Map<number, AssistantBlock & { type: 'tool_use' }>,
): AssistantBlock[] {
  const blockMap = new Map<number, AssistantBlock>();
  for (const [idx, text]     of textByIndex)     blockMap.set(idx, { type: 'text', text });
  for (const [idx, thinking] of thinkingByIndex) blockMap.set(idx, { type: 'thinking', thinking });
  for (const [idx, b]        of toolUseByIndex)  blockMap.set(idx, b);
  return [...blockMap.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
}

// ── Re-export types needed by callers ────────────────────────────────────────

export type { LoopState };
