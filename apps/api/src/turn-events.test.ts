import { describe, expect, it } from "vitest"

import { asId } from "@ema-agent/core-types"
import type { RequestId, SessionId, SseEvent } from "@ema-agent/core-types"

import { TurnEventStore, formatSseEvent, isTerminalEvent } from "./infrastructure/turn-event-store.js"

describe("TurnEventStore", () => {
  it("保存 replay、通知订阅者并记录终态事件", () => {
    const requestId = asId<RequestId>("req_test")
    const sessionId = asId<SessionId>("ses_test")
    const store = new TurnEventStore()
    const received: SseEvent[] = []

    const unsubscribe = store.subscribe(requestId, (event) => {
      received.push(event)
    })

    const completed: SseEvent = {
      type: "turn_completed",
      requestId,
      sessionId,
      at: 1,
    }

    store.publish(completed)
    unsubscribe()

    expect(store.getReplayEvents(requestId)).toEqual([completed])
    expect(received).toEqual([completed])
    expect(store.getTerminalEvent(requestId)).toEqual(completed)
    expect(isTerminalEvent(completed)).toBe(true)
  })

  it("按 SSE wire format 输出 event 与 data", () => {
    const event: SseEvent = {
      type: "turn_completed",
      requestId: asId<RequestId>("req_test"),
      sessionId: asId<SessionId>("ses_test"),
      at: 1,
    }

    expect(formatSseEvent(event)).toContain("event: turn_completed")
    expect(formatSseEvent(event)).toContain("data:")
  })
})
