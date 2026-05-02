import type { RequestId, SseEvent } from "@ema-agent/core-types"

export type TurnEventListener = (event: SseEvent) => void

/**
 * Turn 事件存储骨架。
 *
 * 后续这里负责 SSE replay、订阅、终态事件保存和内存清理。
 */
export class TurnEventStore {
  publish(event: SseEvent): void {
    void event
  }

  getReplayEvents(requestId: RequestId): readonly SseEvent[] {
    void requestId
    return []
  }

  getTerminalEvent(requestId: RequestId): SseEvent | undefined {
    void requestId
    return undefined
  }

  subscribe(requestId: RequestId, listener: TurnEventListener): () => void {
    void requestId
    void listener
    return () => {}
  }
}

export function isTerminalEvent(event: SseEvent): boolean {
  void event
  return false
}

export function formatSseEvent(event: SseEvent): string {
  void event
  return "\n"
}
