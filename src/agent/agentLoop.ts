// 运行一个 Agent 的 LLM→Tool→Result 循环，并在每个持久化边界前暂停事件流。

import type {
  AssistantBlock,
  LlmStopReason,
  LlmTokenUsage,
  ToolResultBlock,
} from '@ema-agent/llm';
import {
  advanceLlmUsageSnapshot,
  ContextWindowExceededError,
} from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import {
  addAgentUsage,
  createAgentLoopState,
  updateAgentLoopState,
} from './agentLoopState.js';
import type { AgentLoopEvent } from './events.js';
import type { AgentLoopInput } from './types.js';


const CONTINUE_OUTPUT_MESSAGE =
  '[系统] 你的输出被截断，请从中断处继续输出剩余内容，不要重复已输出的部分。';
const STUCK_GUIDE_MESSAGE =
  '[系统] 你已连续多轮以完全相同的参数调用相同的工具，没有获得新的信息。请换一个方法、缩小范围，或直接向用户说明当前阻碍。';
const STUCK_BATCH_STREAK = 3;

interface IterationResponse {
  readonly textByIndex: ReadonlyMap<number, string>;
  readonly thinkingByIndex: ReadonlyMap<number, string>;
  readonly thinkingSignatureByIndex: ReadonlyMap<number, string>;
  readonly completedThinkingIndexes: ReadonlySet<number>;
  readonly toolUseByIndex: ReadonlyMap<
    number,
    AssistantBlock & { type: 'tool_use' }
  >;
  readonly stopReason: LlmStopReason;
  readonly usage: LlmTokenUsage;
  readonly durationMs: number;
}

export async function* runAgentLoop(
  input: AgentLoopInput,
): AsyncGenerator<AgentLoopEvent, void> {
  let state = createAgentLoopState();
  let messages = [...input.messages];
  // 最近一次工具批之后累计的输出文本；max_tokens 续写时靠它把几段拼回完整答案。
  const continuedOutput: string[] = [];
  // max_tokens 恢复两步走：先升级重试（顶到预算上限、半截作废重来），
  // 再注入续写提示接着写；两步都失败才判 output_recovery_failed。
  let escalatedMaxOutputTokens = false;
  let injectedContinuation = false;
  // 同一批工具（工具名+参数完全相同）连续调用记轮数；连续 3 轮视为空转，
  // 注入一次提醒让模型换方法，防止原地烧 Token。不硬停，硬兜底靠 maxIterations。
  let lastBatchSignature: string | undefined;
  let sameBatchStreak = 0;
  let stuckGuideInjected = false;

  // AgentLoop 同一时刻最多等待一个工具批次。ToolExecutor 状态变化时调用
  // signalWake 唤醒这个 waiter；唤醒后立即清空，避免旧回调误唤醒下一次等待。
  let wake: (() => void) | undefined;
  const signalWake = (): void => {
    wake?.();
    wake = undefined;
  };

  while (true) {
    input.budget.assertWithinLimits();
    if (input.signal.aborted) {
      state = updateAgentLoopState(state, { phase: 'aborted', stopReason: 'aborted' });
      yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
      return;
    }

    const iteration = state.iterations + 1;
    if (iteration > input.maxIterations) {
      state = updateAgentLoopState(state, {
        phase: 'completed',
        stopReason: 'max_iterations',
      });
      yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
      return;
    }

    const continuesOutput = injectedContinuation;
    state = updateAgentLoopState(state, {
      phase: 'thinking',
      iterations: iteration,
    });
    yield {
      type: 'iteration_started',
      iteration,
      continuesOutput,
      state,
    };

    let prepared = await input.prepareIteration({ messages });
    messages = [...prepared.messages];

    const executor = input.createToolExecutor(signalWake);
    let response!: IterationResponse;
    let recoveryAttempted = false;

    while (true) {
      // Context 超限后的重试仍属于同一次 Agent iteration；每次尝试使用全新累加器，
      // 失败尝试的半截 block 不得混入恢复后的 Assistant Message。
      const callStartedAt = Date.now();
      const textByIndex = new Map<number, string>();
      const thinkingByIndex = new Map<number, string>();
      const thinkingSignatureByIndex = new Map<number, string>();
      const completedThinkingIndexes = new Set<number>();
      const toolUseByIndex = new Map<
        number,
        AssistantBlock & { type: 'tool_use' }
      >();
      let stopReason: LlmStopReason = 'end_turn';
      let usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
      let receivedResponseEvent = false;

      const remainingOutputTokens = input.budget.remainingOutputTokens();
      // 升级重试时放开 prepare 的默认上限，直接顶到预算允许的最大值。
      const preparedMax = escalatedMaxOutputTokens
        ? remainingOutputTokens
        : (prepared.request.maxOutputTokens ?? remainingOutputTokens);
      const request = {
        ...prepared.request,
        maxOutputTokens: Math.min(preparedMax, remainingOutputTokens),
        signal: input.signal,
      };

      try {
        for await (const event of input.llm.stream(request)) {
          receivedResponseEvent = true;
          input.budget.assertWithinLimits();
          switch (event.type) {
            case 'text_delta':
              textByIndex.set(
                event.blockIndex,
                (textByIndex.get(event.blockIndex) ?? '') + event.delta,
              );
              yield {
                type: 'text_delta',
                blockIndex: event.blockIndex,
                delta: event.delta,
              };
              break;

            case 'thinking_delta':
              thinkingByIndex.set(
                event.blockIndex,
                (thinkingByIndex.get(event.blockIndex) ?? '') + event.delta,
              );
              yield {
                type: 'thinking_delta',
                blockIndex: event.blockIndex,
                delta: event.delta,
              };
              break;

            case 'thinking_complete':
              if (event.signature !== undefined) {
                thinkingSignatureByIndex.set(event.blockIndex, event.signature);
              }
              completedThinkingIndexes.add(event.blockIndex);
              yield {
                type: 'thinking_completed',
                blockIndex: event.blockIndex,
                ...(event.signature !== undefined ? { signature: event.signature } : {}),
              };
              break;

            case 'tool_use_delta':
              yield {
                type: 'tool_use_partial',
                blockIndex: event.blockIndex,
                toolCallId: event.callId,
                toolName: event.name,
                argsDelta: event.argsDelta,
              };
              break;

            case 'tool_use_complete':
              input.budget.reserveToolCall();
              toolUseByIndex.set(event.blockIndex, {
                type: 'tool_use',
                id: event.callId,
                name: event.name,
                args: event.args,
              });
              yield {
                type: 'tool_use_completed',
                blockIndex: event.blockIndex,
                toolCallId: event.callId,
                toolName: event.name,
                args: event.args,
              };
              // yield 恢复代表外层已经保存 tool_use；这里只登记，尚不越过副作用边界。
              executor.addTool(event.blockIndex, event.callId, event.name, event.args);
              break;

            case 'usage': {
              const advanced = advanceLlmUsageSnapshot(usage, event);
              usage = advanced.snapshot;
              if (hasUsage(advanced.delta)) {
                input.budget.recordUsage(advanced.delta);
                state = addAgentUsage(state, advanced.delta);
                yield { type: 'usage_updated', usage: state.usage };
              }
              break;
            }

            case 'done':
              stopReason = event.stopReason;
              break;
          }
        }
        response = {
          textByIndex,
          thinkingByIndex,
          thinkingSignatureByIndex,
          completedThinkingIndexes,
          toolUseByIndex,
          stopReason,
          usage,
          durationMs: Date.now() - callStartedAt,
        };
        break;
      } catch (error) {
        if (input.signal.aborted) {
          state = updateAgentLoopState(state, { phase: 'aborted', stopReason: 'aborted' });
          yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
          return;
        }
        if (
          error instanceof ContextWindowExceededError
          && !recoveryAttempted
          && !receivedResponseEvent
        ) {
          recoveryAttempted = true;
          prepared = await input.prepareIteration({
            messages,
            recoveryReason: 'context_window_exceeded',
          });
          messages = [...prepared.messages];
          continue;
        }
        throw error;
      }
    }

    const {
      textByIndex,
      thinkingByIndex,
      thinkingSignatureByIndex,
      completedThinkingIndexes,
      toolUseByIndex,
      stopReason,
      usage,
      durationMs,
    } = response;
    const callText = orderedText(textByIndex);
    for (const blockIndex of thinkingByIndex.keys()) {
      if (completedThinkingIndexes.has(blockIndex)) continue;
      yield { type: 'thinking_completed', blockIndex };
    }

    yield {
      type: 'assistant_message_completed',
      iteration,
      usage,
      stopReason,
      durationMs,
    };

    // 恢复 generator 说明外层已经保存完整 assistant block；此后才允许工具执行。
    if (toolUseByIndex.size > 0) executor.start();

    if (stopReason === 'max_tokens' && toolUseByIndex.size === 0) {
      if (!escalatedMaxOutputTokens) {
        // 升级重试：半截输出作废、不注入任何消息，同一任务顶到预算上限直接重来。
        escalatedMaxOutputTokens = true;
        continue;
      }
      continuedOutput.push(callText);
      if (!injectedContinuation) {
        const partialBlocks = buildAssistantBlocks(
          textByIndex,
          thinkingByIndex,
          thinkingSignatureByIndex,
          new Map(),
        );
        if (partialBlocks.length > 0) {
          messages.push({ role: 'assistant', content: partialBlocks });
        }
        messages.push({ role: 'user', content: CONTINUE_OUTPUT_MESSAGE });
        injectedContinuation = true;
        continue;
      }

      state = updateAgentLoopState(state, {
        phase: 'completed',
        stopReason: 'output_recovery_failed',
      });
      yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
      return;
    }

    if (toolUseByIndex.size === 0) {
      continuedOutput.push(callText);
      messages.push({
        role: 'assistant',
        content: buildAssistantBlocks(
          textByIndex,
          thinkingByIndex,
          thinkingSignatureByIndex,
          new Map(),
        ),
      });
      state = updateAgentLoopState(state, {
        phase: 'completed',
        stopReason: 'completed',
      });
      yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
      return;
    }

    escalatedMaxOutputTokens = false;
    injectedContinuation = false;
    continuedOutput.length = 0;
    state = updateAgentLoopState(state, { phase: 'acting' });
    yield { type: 'phase_changed', state };

    const results: ToolResult[] = [];
    while (!executor.allDone()) {
      for (const result of executor.takeCompletedResults()) {
        results.push(result);
        yield { type: 'tool_result', result };
        // yield 恢复代表外层已经保存 ToolResult，执行状态此时才能关账。
        executor.acknowledgeResult(result.toolCallId);
      }
      if (executor.allDone()) break;

      const nextPhase = executor.hasWaitingUserTool() ? 'waiting_user' : 'acting';
      if (state.phase !== nextPhase) {
        state = updateAgentLoopState(state, { phase: nextPhase });
        yield { type: 'phase_changed', state };
      }

      const parked = new Promise<void>((resolve) => {
        wake = resolve;
      });
      if (executor.allDone()) {
        wake = undefined;
        continue;
      }
      await parked;
    }
    for (const result of executor.takeCompletedResults()) {
      results.push(result);
      yield { type: 'tool_result', result };
      executor.acknowledgeResult(result.toolCallId);
    }

    // 连续多轮完全相同的工具批次视为原地空转：注入一次软引导让模型换方法，
    // 不硬停（轮询类合法重复不能误杀），硬兜底仍归 maxIterations 与 budget。
    const batchSignature = [...toolUseByIndex.values()]
      .map((use) => `${use.name}:${JSON.stringify(use.args)}`)
      .sort()
      .join('|');
    if (batchSignature === lastBatchSignature) {
      sameBatchStreak += 1;
    } else {
      lastBatchSignature = batchSignature;
      sameBatchStreak = 1;
    }
    if (sameBatchStreak >= STUCK_BATCH_STREAK && !stuckGuideInjected) {
      stuckGuideInjected = true;
      messages.push({ role: 'user', content: STUCK_GUIDE_MESSAGE });
    }

    const assistantBlocks = buildAssistantBlocks(
      textByIndex,
      thinkingByIndex,
      thinkingSignatureByIndex,
      toolUseByIndex,
    ).filter((block) => block.type !== 'thinking');
    messages.push({ role: 'assistant', content: assistantBlocks });
    messages.push({
      role: 'user',
      content: results.map(toModelToolResult),
    });
  }
}

function hasUsage(usage: LlmTokenUsage): boolean {
  return usage.inputTokens > 0
    || usage.outputTokens > 0
    || (usage.cacheReadInputTokens ?? 0) > 0
    || (usage.cacheWriteInputTokens ?? 0) > 0;
}

function orderedText(textByIndex: ReadonlyMap<number, string>): string {
  return [...textByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join('');
}

function buildAssistantBlocks(
  textByIndex: ReadonlyMap<number, string>,
  thinkingByIndex: ReadonlyMap<number, string>,
  thinkingSignatureByIndex: ReadonlyMap<number, string>,
  toolUseByIndex: ReadonlyMap<number, AssistantBlock & { type: 'tool_use' }>,
): AssistantBlock[] {
  const blocks = new Map<number, AssistantBlock>();
  for (const [index, text] of textByIndex) {
    blocks.set(index, { type: 'text', text });
  }
  for (const [index, thinking] of thinkingByIndex) {
    const signature = thinkingSignatureByIndex.get(index);
    blocks.set(index, {
      type: 'thinking',
      thinking,
      ...(signature !== undefined ? { signature } : {}),
    });
  }
  for (const [index, toolUse] of toolUseByIndex) {
    blocks.set(index, toolUse);
  }
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
}

function toModelToolResult(result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    toolCallId: result.toolCallId,
    content: result.content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}
