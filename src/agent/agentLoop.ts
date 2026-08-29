// 运行一个 Agent 的 LLM→Tool→Result 循环，并在每个持久化边界前暂停事件流。

import { randomUUID } from 'node:crypto';
import type {
  AssistantBlock,
  LlmGenerationSource,
  LlmStopReason,
  LlmThinkingState,
  LlmTokenUsage,
  Message,
  ToolResultBlock,
} from '@ema-agent/llm';
import {
  createAssistantThinkingBlock,
  ContextWindowExceededError,
  hasLlmTokenUsage,
  llmProviderErrorCode,
  updateLlmCallUsage,
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
  readonly thinkingStateByIndex: ReadonlyMap<number, LlmThinkingState>;
  readonly completedThinkingIndexes: ReadonlySet<number>;
  readonly toolUseByIndex: ReadonlyMap<
    number,
    AssistantBlock & { type: 'tool_use' }
  >;
  readonly stopReason: LlmStopReason;
}

export async function* runAgentLoop(
  input: AgentLoopInput,
): AsyncGenerator<AgentLoopEvent, void> {
  let state = createAgentLoopState();
  let messages = [...input.messages];
  // 最近一次工具批之后累计的输出文本；max_tokens 续写时靠它把几段拼回完整答案。
  const continuedOutput: string[] = [];
  // max_tokens 截断后注入续写提示接着写；只允许续一次，再撞判 output_recovery_failed。
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

    let llmCallId = randomUUID();
    let prepared = await input.prepareIteration({ llmCallId, messages });
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
      const thinkingStateByIndex = new Map<number, LlmThinkingState>();
      const completedThinkingIndexes = new Set<number>();
      const toolUseByIndex = new Map<
        number,
        AssistantBlock & { type: 'tool_use' }
      >();
      let stopReason: LlmStopReason = 'end_turn';
      let usage: LlmTokenUsage = { inputTokens: 0, outputTokens: 0 };
      let receivedResponseEvent = false;

      const request = {
        ...prepared.request,
        signal: input.signal,
      };

      try {
        for await (const event of input.callLlm(request)) {
          receivedResponseEvent = true;
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
              if (event.state !== undefined) {
                thinkingStateByIndex.set(event.blockIndex, event.state);
              }
              completedThinkingIndexes.add(event.blockIndex);
              yield {
                type: 'thinking_completed',
                blockIndex: event.blockIndex,
                ...(event.state !== undefined ? { state: event.state } : {}),
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
              const updated = updateLlmCallUsage(usage, event);
              usage = updated.usage;
              if (hasLlmTokenUsage(updated.delta)) {
                state = addAgentUsage(state, updated.delta);
                yield { type: 'llm_call_usage_updated', llmCallId, usage };
                yield { type: 'agent_usage_updated', usage: state.usage };
              }
              break;
            }

            case 'done':
              stopReason = event.stopReason;
              break;
          }
        }
        const durationMs = Date.now() - callStartedAt;
        yield {
          type: 'llm_call_finished',
          llmCallId,
          source: input.generationSource,
          status: 'completed',
          ...(hasLlmTokenUsage(usage) ? { usage } : {}),
          startedAt: callStartedAt,
          durationMs,
        };
        response = {
          textByIndex,
          thinkingByIndex,
          thinkingStateByIndex,
          completedThinkingIndexes,
          toolUseByIndex,
          stopReason,
        };
        break;
      } catch (error) {
        const cancelled = input.signal.aborted;
        yield {
          type: 'llm_call_finished',
          llmCallId,
          source: input.generationSource,
          status: cancelled ? 'cancelled' : 'failed',
          ...(hasLlmTokenUsage(usage) ? { usage } : {}),
          startedAt: callStartedAt,
          durationMs: Date.now() - callStartedAt,
          ...(!cancelled ? { errorCode: llmProviderErrorCode(error) } : {}),
        };
        if (cancelled) {
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
          llmCallId = randomUUID();
          prepared = await input.prepareIteration({
            llmCallId,
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
      thinkingStateByIndex,
      completedThinkingIndexes,
      toolUseByIndex,
      stopReason,
    } = response;
    const callText = orderedText(textByIndex);
    for (const blockIndex of thinkingByIndex.keys()) {
      if (completedThinkingIndexes.has(blockIndex)) continue;
      yield { type: 'thinking_completed', blockIndex };
    }

    const assistantMessage: Message & { role: 'assistant' } = {
      role: 'assistant',
      content: buildAssistantBlocks(
        textByIndex,
        thinkingByIndex,
        thinkingStateByIndex,
        toolUseByIndex,
      ),
      generatedBy: input.generationSource,
    };
    yield {
      type: 'assistant_message_completed',
      iteration,
      llmCallId,
      stopReason,
    };

    // 恢复 generator 说明外层已经保存完整 assistant block；此后才允许工具执行。
    if (toolUseByIndex.size > 0) executor.start();

    if (stopReason === 'max_tokens' && toolUseByIndex.size === 0) {
      // 输出被模型上限截断：注入续写提示接着写；只允许续一次，再撞判恢复失败。
      continuedOutput.push(callText);
      if (!injectedContinuation) {
        const appended: Message[] = [];
        if (assistantMessage.content.length > 0) {
          messages.push(assistantMessage);
          appended.push(assistantMessage);
        }
        const continuationMessage: Message = {
          role: 'user',
          content: CONTINUE_OUTPUT_MESSAGE,
        };
        messages.push(continuationMessage);
        appended.push(continuationMessage);
        yield { type: 'model_history_appended', llmCallId, messages: appended };
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
      messages.push(assistantMessage);
      yield {
        type: 'model_history_appended',
        llmCallId,
        messages: [assistantMessage],
      };
      state = updateAgentLoopState(state, {
        phase: 'completed',
        stopReason: 'completed',
      });
      yield { type: 'loop_stopped', finalText: continuedOutput.join(''), state };
      return;
    }

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
      const stuckGuide: Message = { role: 'user', content: STUCK_GUIDE_MESSAGE };
      messages.push(stuckGuide);
      yield { type: 'model_history_appended', llmCallId, messages: [stuckGuide] };
    }

    // 完整 assistant 块（含原生推理状态）随 generatedBy 进入下一次迭代：
    // Tool Loop 不剥除 thinking，由目标协议 Adapter 按生成来源裁决重放/删除。
    const toolResultMessage: Message = {
      role: 'user',
      content: results.map(toModelToolResult),
    };
    messages.push(assistantMessage, toolResultMessage);
    yield {
      type: 'model_history_appended',
      llmCallId,
      messages: [assistantMessage, toolResultMessage],
    };
  }
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
  thinkingStateByIndex: ReadonlyMap<number, LlmThinkingState>,
  toolUseByIndex: ReadonlyMap<number, AssistantBlock & { type: 'tool_use' }>,
): AssistantBlock[] {
  const blocks = new Map<number, AssistantBlock>();
  for (const [index, text] of textByIndex) {
    blocks.set(index, { type: 'text', text });
  }
  const thinkingIndexes = new Set([
    ...thinkingByIndex.keys(),
    ...thinkingStateByIndex.keys(),
  ]);
  for (const index of thinkingIndexes) {
    const block = createAssistantThinkingBlock(
      thinkingByIndex.get(index),
      thinkingStateByIndex.get(index),
    );
    if (block) blocks.set(index, block);
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
