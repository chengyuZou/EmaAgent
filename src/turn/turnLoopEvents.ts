// 把已持久化的根循环事件投影给前端, 并处理 Context 用量和物理 LLM 调用记账.
import type { AgentLoopEvent } from '@ema-agent/agent';
import {
  appendEstimatedContextMessages,
  estimatedContextUsage,
  providerContextUsage,
  type ContextUsage,
  type ContextUsageEstimate,
} from '@ema-agent/context';
import type { UsageRecorder } from '@ema-agent/usage';
import type { TurnStreamEvent } from './events.js';
import type { TurnMessageWriter } from './turnMessageWriter.js';
import type { TurnStore } from './turnStore.js';

interface TurnLoopEventsDeps {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turns: Pick<TurnStore, 'setIterations'>;
  readonly writer: Pick<TurnMessageWriter, 'currentAssistantMessageId'>;
  readonly usageRecorder?: Pick<UsageRecorder, 'record'>;
  readonly emit: (event: TurnStreamEvent) => void;
}

/** 每根 Turn 独立维护工具名与 Context 用量. accept 必须在 writer.apply 之后调用. */
export function createTurnLoopEvents(deps: TurnLoopEventsDeps) {
  const { sessionId, turnId, writer, emit } = deps;
  const toolNames = new Map<string, string>();
  const contextEstimates = new Map<string, ContextUsageEstimate>();
  let currentContextUsage:
    | { readonly llmCallId: string; readonly usage: ContextUsage }
    | undefined;

  function onContextPrepared(llmCallId: string, estimate: ContextUsageEstimate): void {
    contextEstimates.set(llmCallId, estimate);
    const usage = estimatedContextUsage(estimate);
    currentContextUsage = { llmCallId, usage };
    emit({ type: 'context_usage_updated', sessionId, turnId, llmCallId, usage });
  }

  /** 根与子 Agent 的物理调用终态进入同一本账; 子调用不更新根 Context 圆环. */
  function recordLlmCall(event: Extract<AgentLoopEvent, { type: 'llm_call_finished' }>): void {
    deps.usageRecorder?.record({
      id: event.llmCallId,
      sessionId,
      turnId,
      providerId: event.source.providerId,
      modelId: event.source.modelId,
      capability: 'llm',
      status: event.status,
      durationMs: event.durationMs,
      inputTokens: event.usage?.inputTokens ?? null,
      outputTokens: event.usage?.outputTokens ?? null,
      cacheReadInputTokens: event.usage?.cacheReadInputTokens ?? null,
      cacheWriteInputTokens: event.usage?.cacheWriteInputTokens ?? null,
      quantity: null,
      unit: null,
      errorCode: event.errorCode ?? null,
      createdAt: event.startedAt,
    });
  }

  function accept(event: AgentLoopEvent): void {
    translate(event);
    if (event.type === 'llm_call_usage_updated') {
      const estimate = contextEstimates.get(event.llmCallId);
      if (estimate) {
        const usage = providerContextUsage(estimate, event.usage);
        currentContextUsage = { llmCallId: event.llmCallId, usage };
        emit({ type: 'context_usage_updated', sessionId, turnId, llmCallId: event.llmCallId, usage });
      }
    }
    if (event.type === 'llm_call_finished') recordLlmCall(event);
    if (event.type === 'model_history_appended') {
      const current = currentContextUsage;
      if (current?.llmCallId === event.llmCallId) {
        const usage = appendEstimatedContextMessages(current.usage, event.messages);
        currentContextUsage = { llmCallId: event.llmCallId, usage };
        emit({ type: 'context_usage_updated', sessionId, turnId, llmCallId: event.llmCallId, usage });
      }
    }
  }

  function translate(event: AgentLoopEvent): void {
    switch (event.type) {
      case 'iteration_started':
        deps.turns.setIterations(turnId, event.iteration);
        emit({
          type: 'agent_iteration',
          sessionId,
          turnId,
          n: event.iteration,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'text_delta':
        emit({
          type: 'output_text_delta',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          delta: event.delta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'thinking_delta':
        emit({
          type: 'reasoning_delta',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          delta: event.delta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'thinking_completed':
        emit({
          type: 'reasoning_complete',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'tool_use_partial':
        emit({
          type: 'tool_call_partial',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          argsDelta: event.argsDelta,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'tool_use_completed':
        toolNames.set(event.toolCallId, event.toolName);
        emit({
          type: 'tool_call_complete',
          sessionId,
          turnId,
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          assistantMessageId: writer.currentAssistantMessageId,
        });
        return;
      case 'agent_usage_updated':
        emit({ type: 'agent_usage_updated', sessionId, turnId, usage: event.usage });
        return;
      case 'tool_result': {
        const { result } = event;
        emit({
          type: 'tool_result',
          sessionId,
          callId: result.toolCallId,
          name: toolNames.get(result.toolCallId) ?? 'unknown',
          ...(result.isError
            ? { error: { code: result.errorCode ?? 'tool/error', message: String(result.content) } }
            : { output: result.data ?? result.content }),
          durationMs: result.durationMs ?? 0,
        });
        return;
      }
      case 'llm_call_usage_updated':
      case 'llm_call_finished':
      case 'assistant_message_completed':
      case 'model_history_appended':
        return;
      default:
        return;
    }
  }

  return { onContextPrepared, accept, recordLlmCall };
}
