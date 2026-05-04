import { describe, expect, it } from "vitest"

import { EMA_MODES, isEmaMode } from "../src/mode.js"

describe("EmaMode", () => {
  describe("EMA_MODES", () => {
    it("包含三种合法模式", () => {
      expect(EMA_MODES).toEqual(["chat", "agent", "narrative"])
    })

    it("是 readonly 的（编译期约束）", () => {
      // 运行时验证三个元素都存在
      expect(EMA_MODES).toHaveLength(3)
      expect(EMA_MODES.includes("chat")).toBe(true)
      expect(EMA_MODES.includes("agent")).toBe(true)
      expect(EMA_MODES.includes("narrative")).toBe(true)
    })
  })

  describe("isEmaMode", () => {
    it.each(["chat", "agent", "narrative"] as const)("对合法 mode '%s' 返回 true", (mode) => {
      expect(isEmaMode(mode)).toBe(true)
    })

    it.each(["Chat", "AGENT", "unknown", "", "  chat  "])("对非法 mode '%s' 返回 false", (mode) => {
      expect(isEmaMode(mode)).toBe(false)
    })

    it("对合法 mode 应用 TypeScript 类型守卫后可以安全赋值给 EmaMode", () => {
      const raw: string = "chat"
      if (isEmaMode(raw)) {
        // 类型收窄：raw 在此作用域内是 EmaMode 而非 string
        const mode: "chat" | "agent" | "narrative" = raw
        expect(mode).toBe("chat")
      } else {
        expect.fail("isEmaMode('chat') 应该返回 true")
      }
    })
  })
})
