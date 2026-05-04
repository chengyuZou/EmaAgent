import type {
  EmaMode,
  MessageId,
  RequestId,
  SessionId,
  StepId,
  SseEvent,
  TurnInputBlock,
} from "@ema-agent/core-types"
import { asId } from "@ema-agent/core-types"

export interface MockTurnInput {
  sessionId: SessionId
  requestId: RequestId
  messageId: MessageId
  mode: EmaMode
  input: TurnInputBlock[]
  abortSignal: AbortSignal
}

/**
 * 临时 turn 事件源骨架。
 *
 * 真实实现接入 LLM、tool、narrative 后，这个文件可以删除或改成测试 fixture。
 */
export async function* createMockTurnEvents(input: MockTurnInput): AsyncIterable<SseEvent> {
  const stepId = asId<StepId>(`step_${crypto.randomUUID()}`)
  const startedAt = Date.now()
  const userText = inputToPlainText(input.input)
  const reply = createMockReply(input.mode, userText)

  yield {
    type: "step_start",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: startedAt,
    stepId,
    stepType: "response",
    title: "生成临时回复",
  }

  for (const chunk of chunkText(reply, 8)) {
    throwIfAborted(input.abortSignal)
    await sleep(16)
    yield {
      type: "text_delta",
      requestId: input.requestId,
      sessionId: input.sessionId,
      at: Date.now(),
      messageId: input.messageId,
      blockId: `text_${input.messageId}`,
      delta: chunk,
    }
  }

  yield {
    type: "text_done",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    messageId: input.messageId,
    blockId: `text_${input.messageId}`,
    fullText: reply,
  }

  yield {
    type: "step_end",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    stepId,
    status: "completed",
  }

  yield {
    type: "turn_completed",
    requestId: input.requestId,
    sessionId: input.sessionId,
    at: Date.now(),
    usage: {
      inputTokens: estimateTokens(userText),
      outputTokens: estimateTokens(reply),
      totalTokens: estimateTokens(userText) + estimateTokens(reply),
    },
  }
}

function inputToPlainText(input: readonly TurnInputBlock[]): string {
  const parts = input.map((block) => {
    if (block.type === "text") {
      return block.text
    }
    if (block.type === "image_ref") {
      return `[image:${block.attachmentId}]`
    }
    if (block.type === "file_ref") {
      return `[file:${block.attachmentId}]`
    }
    return `[artifact:${block.artifactId}]`
  })

  return parts.join("\n").trim()
}

function createMockReply(mode: EmaMode, userText: string): string {
  const normalizedText = userText || "空输入"
  return [
    `Ema 收到：${normalizedText}`,
    `本轮模式：${mode}。`,
    "现在这是 API turn/SSE 管线的临时回复；后续这里会替换成 LlmRegistry.streamChat() 的真实模型流。",
  ].join("\n")
}

function* chunkText(text: string, chunkSize: number): Iterable<string> {
  for (let index = 0; index < text.length; index += chunkSize) {
    yield text.slice(index, index + chunkSize)
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Turn aborted")
  }
}
