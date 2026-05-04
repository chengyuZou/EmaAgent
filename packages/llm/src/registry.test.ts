import { describe, expect, it } from "vitest"

import { asId } from "@ema-agent/core-types"
import type { RequestId, SessionId } from "@ema-agent/core-types"

import { createDefaultLlmConfig } from "./config.js"
import { LlmRegistry } from "./registry.js"

describe("LlmRegistry", () => {
  it("默认无 API Key 时使用 local-dev 绑定并可流式输出", async () => {
    const registry = new LlmRegistry()
    registry.applyConfig(createDefaultLlmConfig({ EMA_LOCAL_DEV_PROVIDER: "1" }))
    const binding = registry.getBinding("chat")
    let text = ""

    expect(binding?.providerId).toBe("local-dev")

    for await (const chunk of registry.streamChat({
      providerId: binding!.providerId,
      requestId: asId<RequestId>("req_llm"),
      sessionId: asId<SessionId>("ses_llm"),
      modelId: binding!.modelId,
      messages: [
        { role: "system", content: "你是 Ema。" },
        { role: "user", content: "你好" },
      ],
      stream: true,
    })) {
      text += chunk.delta.content ?? ""
    }

    expect(text).toContain("本地开发 Provider")
  })
})
