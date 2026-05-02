import type { MessageId, RequestId, SessionId, SseEvent } from "@ema-agent/core-types"
import type { SessionWriter } from "@ema-agent/session"

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

  async run(input: StreamAggregatorInput): Promise<void> {
    void this.writer
    void this.eventStore
    void input
  }
}
