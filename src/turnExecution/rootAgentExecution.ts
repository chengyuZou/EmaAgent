// 运行一个根 Agent 循环，翻译非终态事件并持久化当前 Turn 的消息记录。

import {
  AgentBudgetExceededError,
  DEFAULT_TURN_BUDGET_LIMITS,
  runAgentLoop,
  TurnBudget,
} from '@ema-agent/agent';
import type { EmotionEngine } from '@ema-agent/emotion';
import {
  llmProviderErrorCode,
  type LanguageModel,
} from '@ema-agent/llm';
import type {
  MessageBlocks,
  SessionStore,
  Turn,
} from '@ema-agent/session';
import type { TurnFailureCode, TurnFailurePhase } from '@ema-agent/turn';
import type {
  TurnExecutionEvent,
  TurnInput,
} from './types.js';
import { IterationTranscript } from './iterationTranscript.js';
import { TurnContextBuilder } from './turnContext.js';
import {
  TurnTools,
  TurnToolsBuilder,
  type TurnToolsShutdownReason,
} from './turnTools.js';

/** 根 Agent 只写消息记录，不能完成、失败或取消根 Turn。 */
export type RootAgentTranscript = Pick<SessionStore, 'appendMessage'>;

/** 根 Agent 循环所需服务，不包含根 Turn 终态操作。 */
export interface RootAgentExecutionDeps {
  readonly transcript: RootAgentTranscript;
  readonly llm: LanguageModel;
  readonly emotion: EmotionEngine;
}

export interface RootAgentExecutionRequest {
  readonly turn: Turn;
  readonly input: TurnInput;
  readonly signal: AbortSignal;
}

/** TurnExecutor 根据该结果提交唯一根终态。 */
export type RootAgentExecutionResult =
  | {
      readonly status: 'completed';
      readonly iterations: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly status: 'failed';
      readonly code: TurnFailureCode;
      readonly message: string;
      readonly phase: TurnFailurePhase;
    }
  | {
      readonly status: 'aborted';
      readonly reason: string;
    };

/**
 * 根 Agent 执行协作者。
 *
 * 它拥有 Context、Tool 和 AgentLoop 的一次性组合，但不创建 Turn、不写根终态，
 * 也不认识 HTTP、SSE 或 Desktop。
 */
export class RootAgentExecution {
  private readonly activeTools = new Map<string, TurnTools>();

  constructor(
    private readonly deps: RootAgentExecutionDeps,
    private readonly contextBuilder: TurnContextBuilder,
    private readonly toolsBuilder: TurnToolsBuilder,
  ) {}

  /** 只取消指定子 AgentRun，不中止父 Turn。 */
  abortAgentRun(turnId: string, agentRunId: Parameters<TurnTools['abortAgentRun']>[0]): void {
    this.activeTools.get(turnId)?.abortAgentRun(agentRunId);
  }

  /** 只取消指定工具调用；找不到时返回 false。 */
  abortTool(turnId: string, toolCallId: string): boolean {
    return this.activeTools.get(turnId)?.abortTool(toolCallId) ?? false;
  }

  async *run(
    request: RootAgentExecutionRequest,
  ): AsyncGenerator<TurnExecutionEvent, RootAgentExecutionResult> {
    const { turn, input, signal } = request;
    const { transcript, llm, emotion } = this.deps;
    const { providerId, model } = input.model;
    const sessionId = turn.sessionId;
    const turnId = turn.id;
    const budget = new TurnBudget({
      ...DEFAULT_TURN_BUDGET_LIMITS,
      maxToolCalls: input.settings.agent.maxToolCalls,
      maxSubagents: input.settings.agent.maxSubagents,
      maxConcurrentSubagents: input.settings.agent.maxConcurrentSubagents,
    });
    const iteration = new IterationTranscript();
    const emitRef: { fn?: (event: TurnExecutionEvent) => void } = {};

    let activePhase: TurnFailurePhase = 'provider';
    let turnTools: TurnTools | undefined;
    let iterations = 0;

    const stopTools = async (
      reason: TurnToolsShutdownReason,
    ): Promise<void> => {
      await turnTools?.shutdown(reason);
    };

    try {
      emotion.beginTurn(sessionId);

      const toolsForTurn = await this.toolsBuilder.prepare({
        turn,
        input,
        signal,
        budget,
      });
      turnTools = toolsForTurn;
      this.activeTools.set(turnId, toolsForTurn);
      const policy = toolsForTurn.policy;
      const preparedContext = yield* streamOperation((emit) =>
        this.contextBuilder.prepare({
          turn,
          input,
          signal,
          emit,
        }));
      if (preparedContext.degradation) {
        yield {
          type: 'request_degraded',
          sessionId,
          turnId,
          ...preparedContext.degradation,
        };
      }

      activePhase = 'persistence';
      if (input.persistedUserInput !== undefined) {
        transcript.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          blocks: input.persistedUserInput,
        });
      }

      // Narrative 块属于 UI 正式记录，但历史投影不会把它当普通用户消息重放。
      if (preparedContext.narrativeTimelines.length > 0) {
        transcript.appendMessage({
          turnId,
          sessionId,
          role: 'user',
          kind: 'narrative_context',
          blocks: { timelines: [...preparedContext.narrativeTimelines] },
        });
      }

      activePhase = 'provider';
      const agentLoop = runAgentLoop<TurnExecutionEvent>({
        messages: preparedContext.messages,
        policy,
        buildExecutor: (args) => {
          emitRef.fn = args.pushEv;
          return toolsForTurn.buildExecutor(args);
        },
        llm,
        historyMessageCount: preparedContext.historyMessageCount,
        providerId,
        model,
        signal,
        maxIterations: policy.maxIterations(),
        budget,
        sessionId,
        turnId,
        getScratchpadContext: input.scratchpadDir
          ? () => toolsForTurn.readScratchpadContext()
          : undefined,
        assembleContext: async ({
          history,
          currentTurn,
          scratchpadContext,
          mailboxMessages,
          forceCompaction,
          toolPool,
        }) => preparedContext.assemble({
          history,
          currentTurn,
          scratchpadContext,
          mailboxMessages,
          activeSkills: toolsForTurn.activeSkills(),
          toolPool,
          forceCompaction,
          emit: (event) => emitRef.fn?.(event),
        }),
        onLlmRequestPrepared: ({ llmCallId, messages }) => {
          if (preparedContext.usageEstimate) {
            emitRef.fn?.({
              type: 'llm_context_prepared',
              sessionId,
              turnId,
              llmCallId,
              estimate: preparedContext.usageEstimate,
            });
          }
          toolsForTurn.updateParentContext(messages);
        },
        thinking: input.thinking,
      });

      let loopStep = await agentLoop.next();
      while (!loopStep.done) {
        const event = loopStep.value;
        switch (event.type) {
          case 'loop_iteration':
            iterations = event.n;
            iteration.beginIteration(event.continuesOutput);
            yield {
              type: 'agent_iteration',
              sessionId,
              turnId,
              n: event.n,
            };
            break;

          case 'loop_text_delta': {
            const processed = emotion.processChunk(
              event.delta,
              turnId,
              sessionId,
            );
            if (processed.cleaned) {
              iteration.appendText(event.blockIndex, processed.cleaned);
              yield {
                type: 'output_text_delta',
                sessionId,
                turnId,
                blockIndex: event.blockIndex,
                delta: processed.cleaned,
              };
            }
            for (const emotionEvent of processed.events) {
              yield emotionEvent;
            }
            break;
          }

          case 'loop_thinking_delta':
            iteration.appendThinking(event.blockIndex, event.delta);
            yield {
              type: 'reasoning_delta',
              sessionId,
              turnId,
              blockIndex: event.blockIndex,
              delta: event.delta,
            };
            break;

          case 'loop_thinking_complete':
            iteration.setThinkingSignature(
              event.blockIndex,
              event.signature,
            );
            yield {
              type: 'reasoning_complete',
              sessionId,
              turnId,
              blockIndex: event.blockIndex,
            };
            break;

          case 'loop_tool_partial':
            yield {
              type: 'tool_call_partial',
              sessionId,
              blockIndex: event.blockIndex,
              callId: event.callId,
              name: event.name,
              argsDelta: event.argsDelta,
            };
            break;

          case 'loop_tool_complete':
            iteration.setToolCall(event.blockIndex, {
              type: 'tool_use',
              id: event.callId,
              name: event.name,
              args: event.args,
            });
            yield {
              type: 'tool_call_complete',
              sessionId,
              blockIndex: event.blockIndex,
              callId: event.callId,
              name: event.name,
              args: event.args,
            };
            break;

          case 'loop_relay':
            yield event.ev;
            break;

          case 'loop_usage':
            yield {
              type: 'usage_update',
              sessionId,
              turnId,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
            };
            break;

          case 'loop_llm_complete': {
            const { cleaned: tail } = emotion.flush(turnId, sessionId);
            if (tail) {
              const blockIndex = iteration.firstTextBlockIndex();
              iteration.appendText(blockIndex, tail);
              yield {
                type: 'output_text_delta',
                sessionId,
                turnId,
                blockIndex,
                delta: tail,
              };
            }

            if (iteration.toolCalls().length > 0) {
              activePhase = 'persistence';
              transcript.appendMessage({
                turnId,
                sessionId,
                role: 'assistant',
                blocks: iteration.assistantBlocks() as MessageBlocks,
              });
              activePhase = 'provider';
            }

            break;
          }

          case 'loop_request_degraded':
            yield {
              type: 'request_degraded',
              sessionId,
              turnId,
              attempt: event.attempt,
              reason: event.reason,
              removed: event.removed,
              replacements: event.replacements,
            };
            break;

          case 'loop_tool_result': {
            activePhase = 'persistence';
            transcript.appendMessage({
              turnId,
              sessionId,
              role: 'user',
              kind: 'tool_results',
              blocks: [event.result] as MessageBlocks,
            });
            activePhase = 'provider';
            break;
          }

          case 'loop_breaker':
            yield {
              type: 'agent_breaker_tripped',
              sessionId,
              turnId,
              reason: event.reason,
            };
            break;
        }

        loopStep = await agentLoop.next();
      }

      const loopOutcome = loopStep.value;
      if (
        loopOutcome.state.transition === 'no_tool_calls'
        || loopOutcome.state.transition === 'max_output_tokens_recovery'
      ) {
        activePhase = 'persistence';
        const blocks = iteration.assistantBlocks();
        transcript.appendMessage({
          turnId,
          sessionId,
          role: 'assistant',
          blocks: blocks as MessageBlocks,
        });

        activePhase = 'provider';
      }

      if (signal.aborted) {
        await stopTools('aborted');
        return { status: 'aborted', reason: 'user_stop' };
      }

      await stopTools('completed');
      return {
        status: 'completed',
        iterations,
        inputTokens: loopOutcome.state.usage.inputTokens,
        outputTokens: loopOutcome.state.usage.outputTokens,
      };
    } catch (error) {
      await stopTools(signal.aborted ? 'aborted' : 'failed');
      if (signal.aborted) {
        return { status: 'aborted', reason: 'user_stop' };
      }

      const message = error instanceof Error ? error.message : String(error);
      const code: TurnFailureCode = error instanceof AgentBudgetExceededError
        ? error.code
        : activePhase === 'provider'
          ? llmProviderErrorCode(error)
          : 'turn/execution_failed';
      return {
        status: 'failed',
        code,
        message,
        phase: activePhase,
      };
    } finally {
      emitRef.fn = undefined;
      await stopTools('finished');
      this.activeTools.delete(turnId);
    }
  }
}

/**
 * 长耗时 Context 提供者执行期间立即转发领域事件，避免召回完成后成批刷新 UI。
 */
async function* streamOperation<T>(
  operation: (
    emit: (event: TurnExecutionEvent) => void,
  ) => Promise<T>,
): AsyncGenerator<TurnExecutionEvent, T> {
  const queue: TurnExecutionEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let value!: T;
  let error: unknown;

  operation((event) => {
    queue.push(event);
    notify?.();
    notify = null;
  }).then(
    (result) => {
      value = result;
      done = true;
      notify?.();
      notify = null;
    },
    (reason: unknown) => {
      error = reason;
      done = true;
      notify?.();
      notify = null;
    },
  );

  while (!done || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!done) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  if (error !== undefined) throw error;
  return value;
}
