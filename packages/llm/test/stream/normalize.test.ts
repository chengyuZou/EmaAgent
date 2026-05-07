import { describe, expect, it } from "vitest"
import { normalizeEvent } from "../../src/stream/normalize.js"
import type { XsaiStreamEvent } from "../../src/stream/normalize.js"

describe("normalizeEvent", () => {
  describe("text-delta", () => {
    it("produces a content delta chunk", () => {
      const event: XsaiStreamEvent = { type: "text-delta", text: "Hello" }
      const chunk = normalizeEvent(event, 0)
      expect(chunk).not.toBeNull()
      expect(chunk!.index).toBe(0)
      expect(chunk!.delta.content).toBe("Hello")
      expect(chunk!.finishReason).toBeNull()
    })
  })

  describe("tool-call-streaming-start", () => {
    it("produces a toolCalls chunk with empty argumentsDelta", () => {
      const event: XsaiStreamEvent = {
        type: "tool-call-streaming-start",
        toolCallId: "tc_001",
        toolName: "read_file",
      }
      const chunk = normalizeEvent(event, 1)
      expect(chunk).not.toBeNull()
      expect(chunk!.toolCalls).toHaveLength(1)
      expect(chunk!.toolCalls![0].toolName).toBe("read_file")
      expect(chunk!.toolCalls![0].argumentsDelta).toBe("")
      expect(chunk!.finishReason).toBeNull()
    })
  })

  describe("tool-call-delta", () => {
    it("produces a toolCalls chunk with argumentsDelta", () => {
      const event: XsaiStreamEvent = {
        type: "tool-call-delta",
        toolCallId: "tc_001",
        toolName: "read_file",
        argsTextDelta: '{"path":',
      }
      const chunk = normalizeEvent(event, 2)
      expect(chunk).not.toBeNull()
      expect(chunk!.toolCalls![0].argumentsDelta).toBe('{"path":')
    })
  })

  describe("finish", () => {
    it("maps 'stop' finishReason", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "stop" }
      const chunk = normalizeEvent(event, 3)
      expect(chunk!.finishReason).toBe("stop")
    })

    it("maps 'length' finishReason", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "length" }
      expect(normalizeEvent(event, 0)!.finishReason).toBe("length")
    })

    it("maps xsai 'tool-calls' to EmaAgent 'tool_calls'", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "tool-calls" }
      const chunk = normalizeEvent(event, 4)
      expect(chunk!.finishReason).toBe("tool_calls")
    })

    it("maps 'content_filter' finishReason", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "content_filter" }
      expect(normalizeEvent(event, 0)!.finishReason).toBe("content_filter")
    })

    it("maps unknown finishReason to null", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "something_else" }
      expect(normalizeEvent(event, 0)!.finishReason).toBeNull()
    })

    it("maps usage when present", () => {
      const event: XsaiStreamEvent = {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }
      const chunk = normalizeEvent(event, 0)
      expect(chunk!.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })
    })

    it("omits usage when not present", () => {
      const event: XsaiStreamEvent = { type: "finish", finishReason: "stop" }
      expect(normalizeEvent(event, 0)!.usage).toBeUndefined()
    })

    it("defaults missing usage fields to 0", () => {
      const event: XsaiStreamEvent = {
        type: "finish",
        finishReason: "stop",
        usage: {},
      }
      const chunk = normalizeEvent(event, 0)
      expect(chunk!.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    })
  })

  describe("error", () => {
    it("throws the original Error", () => {
      const err = new Error("API failure")
      const event: XsaiStreamEvent = { type: "error", error: err }
      expect(() => normalizeEvent(event, 0)).toThrow("API failure")
    })

    it("wraps non-Error values in a new Error", () => {
      const event: XsaiStreamEvent = { type: "error", error: "string error" }
      expect(() => normalizeEvent(event, 0)).toThrow("string error")
    })
  })

  describe("ignored event types", () => {
    it.each(["tool-call", "tool-result", "reasoning-delta"] as const)(
      "returns null for '%s'",
      (type) => {
        const event = { type } as unknown as XsaiStreamEvent
        expect(normalizeEvent(event, 0)).toBeNull()
      },
    )
  })

  describe("index passthrough", () => {
    it("preserves the index on all non-null chunks", () => {
      const cases: XsaiStreamEvent[] = [
        { type: "text-delta", text: "x" },
        { type: "tool-call-streaming-start", toolCallId: "t", toolName: "f" },
        { type: "finish", finishReason: "stop" },
      ]
      cases.forEach((event, i) => {
        expect(normalizeEvent(event, i)!.index).toBe(i)
      })
    })
  })
})
