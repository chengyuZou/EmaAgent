import type {
  AgentPhase,
  ChatMessage,
  MessageContentBlock,
  MessageId,
  RequestId,
  SessionId,
  SseEvent,
  PhaseId,
  ToolCallId,
} from "@ema-agent/core-types"
import type { SessionWriter } from "@ema-agent/session"

import { isTerminalEvent } from "./turn-event-store.js"
import type { TurnEventStore } from "./turn-event-store.js"

export interface StreamAggregatorInput {
  sessionId: SessionId
  requestId: RequestId
  assistantMessageId: MessageId
  abortSignal: AbortSignal
  events: AsyncIterable<SseEvent>
}

interface PhaseAccumulator {
  phase: string
  title: string
  detail?: string
  startedAt: number
}

export class StreamAggregator {
  constructor(
    private readonly writer: SessionWriter,
    private readonly eventStore: TurnEventStore,
  ) {}

  async run(input: StreamAggregatorInput): Promise<SseEvent | undefined> {
    const blocks: MessageContentBlock[] = []
    const toolNamesById = new Map<ToolCallId, string>()
    const phaseById = new Map<PhaseId, PhaseAccumulator>()
    let textBlockIndex: number | undefined
    let terminalEvent: SseEvent | undefined

    for await (const event of input.events) {
      if (input.abortSignal.aborted) {
        throw new Error("Turn aborted")
      }

      this.eventStore.publish(event)
      if (event.type === "tool_call_start") {
        toolNamesById.set(event.toolCallId, event.toolName)
      }
      if (event.type === "phase_start") {
        phaseById.set(event.phaseId, {
          phase: event.phase,
          title: event.title,
          startedAt: event.at,
        })
      }
      if (event.type === "phase_progress") {
        const acc = phaseById.get(event.phaseId)
        if (acc) {
          acc.detail = event.detail
        }
      }
      applyEventToAssistantBlocks(blocks, event, toolNamesById, phaseById, (text) => {
        if (textBlockIndex === undefined) {
          textBlockIndex = blocks.length
          blocks.push({ type: "text", text })
          return
        }
        blocks[textBlockIndex] = { type: "text", text }
      })

      if (blocks.length > 0 || isTerminalEvent(event)) {
        await this.writer.upsertAssistantMessage(
          input.sessionId,
          createAssistantMessage({
            messageId: input.assistantMessageId,
            requestId: input.requestId,
            blocks,
            status: event.type === "error" ? "error" : event.type === "turn_completed" ? "complete" : "generating",
            errorCode: event.type === "error" ? event.code : undefined,
          }),
        )
      }

      if (isTerminalEvent(event)) {
        terminalEvent = event
        break
      }
    }

    return terminalEvent
  }
}

function createAssistantMessage(input: {
  messageId: MessageId
  requestId: RequestId
  blocks: readonly MessageContentBlock[]
  status: ChatMessage["status"]
  errorCode?: string
}): ChatMessage {
  return {
    id: input.messageId,
    role: "assistant",
    contentBlocks: [...input.blocks],
    requestId: input.requestId,
    status: input.status,
    errorCode: input.errorCode,
    createdAt: Date.now(),
  }
}

function applyEventToAssistantBlocks(
  blocks: MessageContentBlock[],
  event: SseEvent,
  toolNamesById: ReadonlyMap<ToolCallId, string>,
  phaseById: ReadonlyMap<PhaseId, PhaseAccumulator>,
  updateText: (text: string) => void,
): void {
  if (event.type === "text_delta") {
    const currentText = getCurrentText(blocks)
    updateText(`${currentText}${event.delta}`)
    return
  }

  if (event.type === "text_done") {
    updateText(event.fullText)
    return
  }

  if (event.type === "tool_call_end") {
    blocks.push({
      type: "tool_call",
      toolCallId: event.toolCallId,
      toolName: toolNamesById.get(event.toolCallId) ?? "tool",
      args: event.args,
    })
    return
  }

  if (event.type === "tool_result") {
    blocks.push({
      type: "tool_result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      success: event.success,
      resultStr: event.resultStr,
      durationMs: event.durationMs,
    })
    return
  }

  if (event.type === "permission_request") {
    blocks.push({
      type: "permission_request",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      summary: event.summary,
      risk: event.risk,
    })
    return
  }

  if (event.type === "artifact_create" || event.type === "artifact_finalize") {
    blocks.push({
      type: "artifact_ref",
      artifact: event.summary,
    })
    return
  }

  if (event.type === "retrieval_end") {
    blocks.push({
      type: "retrieval",
      source: event.source,
      content: event.content,
    })
    return
  }

  if (event.type === "compression_notify") {
    blocks.push({
      type: "compression",
      originalTokens: event.originalTokens,
      compressedTokens: event.compressedTokens,
      content: event.content,
    })
    return
  }

  if (event.type === "image") {
    blocks.push({
      type: "image",
      url: event.url,
      mimeType: event.mimeType,
      alt: event.alt,
    })
    return
  }

  if (event.type === "phase_end") {
    const acc = phaseById.get(event.phaseId)
    if (acc) {
      blocks.push({
        type: "phase",
        phaseId: event.phaseId,
        phase: acc.phase as AgentPhase,
        title: acc.title,
        status: event.status,
        detail: acc.detail,
        artifactIds: event.artifactIds as string[] | undefined,
        startedAt: acc.startedAt,
        endedAt: event.at,
      })
    }
    return
  }

  if (event.type === "error") {
    blocks.push({
      type: "error",
      code: event.code,
      message: event.message,
    })
  }
}

function getCurrentText(blocks: readonly MessageContentBlock[]): string {
  const textBlock = blocks.find((block): block is Extract<MessageContentBlock, { type: "text" }> => block.type === "text")
  return textBlock?.text ?? ""
}
