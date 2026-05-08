import type {
  EmaMode,
  MessageId,
  PhaseId,
  RequestId,
  SessionId,
  SseEvent,
  StartTurnRequest,
  ToolCallId,
  TurnInputBlock,
  UsageView,
} from "@ema-agent/core-types"
import { estimateUsageCost } from "@ema-agent/llm"
import type { LlmRegistry } from "@ema-agent/llm"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import {
  createChatCompletionMessages,
  createStageCueEvent,
  getModeModelOverride,
  mapLlmChunkToEvents,
  mapModeToRole,
  resolveModelBinding,
  throwIfAborted,
  type ToolCallDraft,
} from "./flow-helpers.js"

export interface ChatFlowInput {
  sessionId: SessionId
  requestId: RequestId
  messageId: MessageId
  phaseId: PhaseId
  mode: EmaMode
  input: readonly TurnInputBlock[]
  modelOverrides?: StartTurnRequest["modelOverrides"]
  abortSignal: AbortSignal
}

export async function* runChatFlow(
  storage: SqliteStorage,
  llmRegistry: LlmRegistry,
  input: ChatFlowInput,
): AsyncIterable<SseEvent> {
  const binding = resolveModelBinding(llmRegistry, mapModeToRole(input.mode), getModeModelOverride(input.mode, input.modelOverrides))
  const messages = await createChatCompletionMessages(storage, input.sessionId, input.mode)

  yield createStageCueEvent(input.requestId, input.sessionId, "phase", {
    expression: "neutral",
    mouth: "idle",
    priority: 20,
  })

  let fullText = ""
  let lastUsage: UsageView | undefined
  const toolCalls = new Map<ToolCallId, ToolCallDraft>()

  for await (const chunk of llmRegistry.streamChat({
    providerId: binding.providerId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    modelId: binding.modelId,
    messages,
    stream: true,
    temperature: 0.7,
    maxTokens: 2048,
  })) {
    throwIfAborted(input.abortSignal)

    for (const event of mapLlmChunkToEvents({
      chunk,
      requestId: input.requestId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCalls,
    })) {
      if (event.type === "text_delta") fullText += event.delta
      yield event
    }

    if (chunk.usage) lastUsage = chunk.usage
  }

  yield {
    type: "text_done",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    messageId: input.messageId,
    blockId: `text_${input.messageId}`,
    fullText,
  }

  yield createStageCueEvent(input.requestId, input.sessionId, "system", {
    expression: "happy",
    motion: "nod",
    mouth: "idle",
    priority: 10,
    durationMs: 1200,
  })

  yield {
    type: "turn_completed",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    usage: lastUsage
      ? estimateUsageCost({ providerId: binding.providerId, modelId: binding.modelId, usage: lastUsage })
      : undefined,
  }
}
