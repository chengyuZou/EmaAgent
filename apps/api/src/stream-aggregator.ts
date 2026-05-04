import type {
  ChatMessage,
  MessageContentBlock,
  MessageId,
  RequestId,
  SessionId,
  SseEvent,
  ToolCallId,
} from "@ema-agent/core-types"
import type { SessionWriter } from "@ema-agent/session"

import { isTerminalEvent } from "./turn-events.js"
import type { TurnEventStore } from "./turn-events.js"

export interface StreamAggregatorInput {
  sessionId: SessionId
  requestId: RequestId
  assistantMessageId: MessageId
  abortSignal: AbortSignal
  events: AsyncIterable<SseEvent>
}

/**
 * 流聚合器骨架。
 *
 * 后续这里负责把 provider/tool/narrative 的内部流转换成 SSE，
 * 并在 text delta 期间 upsert assistant message。
 */
export class StreamAggregator {
  constructor(
    private readonly writer: SessionWriter,
    private readonly eventStore: TurnEventStore,
  ) {}

  async run(input: StreamAggregatorInput): Promise<SseEvent | undefined> {
    const blocks: MessageContentBlock[] = []
    const toolNamesById = new Map<ToolCallId, string>()
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
      applyEventToAssistantBlocks(blocks, event, toolNamesById, (text) => {
        if (textBlockIndex === undefined) {
          textBlockIndex = blocks.length
          blocks.push({ type: "text", text })
          return
        }
        blocks[textBlockIndex] = { type: "text", text }
      })

      if (blocks.length > 0 || isTerminalEvent(event)) {
        await this.writer.upsertAssistantMessage({
          sessionId: input.sessionId,
          requestId: input.requestId,
          message: createAssistantMessage({
            messageId: input.assistantMessageId,
            requestId: input.requestId,
            blocks,
            status: event.type === "error" ? "error" : event.type === "turn_completed" ? "complete" : "generating",
            errorCode: event.type === "error" ? event.code : undefined,
          }),
        })
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

  if (event.type === "step_progress") {
    blocks.push({
      type: "step",
      stepId: event.stepId,
      detail: event.detail,
    })
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
