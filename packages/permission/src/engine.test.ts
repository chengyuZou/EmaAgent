import { describe, expect, it } from "vitest"

import { asId } from "@ema-agent/core-types"
import type { RequestId, SessionId, ToolCallId } from "@ema-agent/core-types"

import { PermissionEngine, createDefaultPermissionPolicy } from "./engine.js"

describe("PermissionEngine", () => {
  it("按 deny > prompt > allow 评估权限", () => {
    const engine = new PermissionEngine(createDefaultPermissionPolicy())
    const result = engine.evaluate({
      requestId: asId<RequestId>("req_permission"),
      sessionId: asId<SessionId>("ses_permission"),
      toolCallId: asId<ToolCallId>("tool_permission"),
      toolName: "write_file",
      summary: "写入文件",
      risk: "medium",
      writesFiles: true,
      needsNetwork: false,
      paths: ["src/index.ts"],
    })

    expect(result.decision).toBe("prompt")
  })
})
