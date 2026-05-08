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
import type { NarrativeBridgeClient } from "@ema-agent/narrative"
import { narrativeResultToContext } from "@ema-agent/narrative"
import type { SqliteStorage } from "@ema-agent/storage-sql"
import type { TurnEventStore } from "../infrastructure/turn-event-store.js"

import {
  createChatCompletionMessages,
  createStageCueEvent,
  getModeModelOverride,
  inputToPlainText,
  mapLlmChunkToEvents,
  mapModeToRole,
  resolveModelBinding,
  throwIfAborted,
  type ToolCallDraft,
} from "./flow-helpers.js"

export interface NarrativeFlowInput {
  sessionId: SessionId
  requestId: RequestId
  messageId: MessageId
  phaseId: PhaseId
  mode: EmaMode
  input: readonly TurnInputBlock[]
  modelOverrides?: StartTurnRequest["modelOverrides"]
  abortSignal: AbortSignal
}

export async function* runNarrativeFlow(
  storage: SqliteStorage,
  llmRegistry: LlmRegistry,
  narrativeClient: NarrativeBridgeClient,
  eventStore: TurnEventStore,
  input: NarrativeFlowInput,
): AsyncIterable<SseEvent> {
  const binding = resolveModelBinding(llmRegistry, mapModeToRole(input.mode), getModeModelOverride(input.mode, input.modelOverrides))
  const userText = inputToPlainText(input.input)

  // Retrieval
  eventStore.publish({
    type: "retrieval_start",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    messageId: input.messageId,
    source: "narrative",
  })

  const result = await narrativeClient.query({ worldId: "default", sceneContext: "", query: userText })
  const context = narrativeResultToContext(result)

  eventStore.publish({
    type: "retrieval_end",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    messageId: input.messageId,
    source: "narrative",
    content: context || "未召回到剧情片段。",
  })

  const messages = await createChatCompletionMessages(storage, input.sessionId, input.mode, context || undefined)

  yield createStageCueEvent(input.requestId, input.sessionId, "phase", {
    expression: "curious",
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
