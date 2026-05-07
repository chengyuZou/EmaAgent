import { describe, expect, it } from "vitest"
import {
  isToolUnsupportedError,
  normalizeProviderError,
  TOOL_UNSUPPORTED_PATTERNS,
} from "../../src/usage/errors.js"

describe("isToolUnsupportedError", () => {
  it("returns false for a generic error", () => {
    expect(isToolUnsupportedError(new Error("network timeout"))).toBe(false)
  })

  it("returns false for a non-Error string", () => {
    expect(isToolUnsupportedError("something went wrong")).toBe(false)
  })

  const unsupportedMessages = [
    "This model does not support tools",
    "no endpoints found that support tool use",
    "invalid schema for function read_file",
    "invalid function parameters provided",
    "functions are not supported by this endpoint",
    "unrecognized request argument: tools",
    "tool use with function calling is unsupported",
    "tool_use_failed: model cannot call tools",
    "does not support function calling",
    "tools are not supported for this model",
    "Tool is not supported here",
  ]

  unsupportedMessages.forEach((msg) => {
    it(`matches: "${msg.slice(0, 50)}"`, () => {
      expect(isToolUnsupportedError(new Error(msg))).toBe(true)
    })
  })

  it("is case-insensitive", () => {
    expect(isToolUnsupportedError(new Error("DOES NOT SUPPORT TOOLS"))).toBe(true)
  })

  it("matches string errors (not just Error instances)", () => {
    expect(isToolUnsupportedError("does not support tools")).toBe(true)
  })

  it("TOOL_UNSUPPORTED_PATTERNS exports exactly 10 patterns", () => {
    expect(TOOL_UNSUPPORTED_PATTERNS).toHaveLength(10)
  })
})

describe("normalizeProviderError", () => {
  it("returns the same Error instance when given an Error", () => {
    const err = new Error("original")
    expect(normalizeProviderError(err)).toBe(err)
  })

  it("wraps a string in an Error", () => {
    const result = normalizeProviderError("string error")
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe("string error")
  })

  it("wraps null in an Error", () => {
    const result = normalizeProviderError(null)
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe("null")
  })

  it("wraps an object in an Error via String()", () => {
    const result = normalizeProviderError({ code: 429 })
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain("object")
  })
})
