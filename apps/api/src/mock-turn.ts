import type {
  EmaMode,
  MessageId,
  RequestId,
  SessionId,
  SseEvent,
  TurnInputBlock,
} from "@ema-agent/core-types"

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
  void input
}
