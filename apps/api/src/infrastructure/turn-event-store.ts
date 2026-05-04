import type { RequestId, SseEvent } from "@ema-agent/core-types"

export type TurnEventListener = (event: SseEvent) => void

export class TurnEventStore {
  private readonly replayEvents = new Map<RequestId, SseEvent[]>()
  private readonly listeners = new Map<RequestId, Set<TurnEventListener>>()
  private readonly terminalEvents = new Map<RequestId, SseEvent>()

  publish(event: SseEvent): void {
    const events = this.replayEvents.get(event.requestId) ?? []
    events.push(event)
    this.replayEvents.set(event.requestId, events)

    if (isTerminalEvent(event)) {
      this.terminalEvents.set(event.requestId, event)
    }

    const listeners = this.listeners.get(event.requestId)
    for (const listener of listeners ?? []) {
      listener(event)
    }
  }

  getReplayEvents(requestId: RequestId): readonly SseEvent[] {
    return [...(this.replayEvents.get(requestId) ?? [])]
  }

  getTerminalEvent(requestId: RequestId): SseEvent | undefined {
    return this.terminalEvents.get(requestId)
  }

  subscribe(requestId: RequestId, listener: TurnEventListener): () => void {
    const listeners = this.listeners.get(requestId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(requestId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(requestId)
      }
    }
  }
}

export function isTerminalEvent(event: SseEvent): boolean {
  return event.type === "turn_completed" || event.type === "error"
}

export function formatSseEvent(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
