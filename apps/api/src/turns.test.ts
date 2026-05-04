import { describe, expect, it } from "vitest"

import { asId } from "@ema-agent/core-types"
import type { RequestId, SessionId } from "@ema-agent/core-types"
import { LlmRegistry, createDefaultLlmConfig } from "@ema-agent/llm"
import { createSqliteStorage } from "@ema-agent/storage-sql"

import { TurnEventStore } from "./turn-events.js"
import { TurnService } from "./turns.js"

describe("TurnService chat 闭环", () => {
  it("发起 chat turn 后流式生成助手消息并落盘", async () => {
    const storage = createSqliteStorage(":memory:")
    const eventStore = new TurnEventStore()
    const registry = new LlmRegistry()
    registry.applyConfig(createDefaultLlmConfig({ EMA_LOCAL_DEV_PROVIDER: "1" }))
    const service = new TurnService(storage, eventStore, registry)

    const response = await service.startTurn({
      sessionId: asId<SessionId>("ses_chat_loop"),
      mode: "chat",
      input: [{ type: "text", text: "帮我确认聊天闭环是否能保存消息" }],
    })

    await waitForTerminalEvent(eventStore, response.requestId)

    const messages = await storage.messages.listMessagesByRequest(response.requestId)
    const assistant = messages.find((message) => message.role === "assistant")

    expect(messages.some((message) => message.role === "user")).toBe(true)
    expect(assistant?.status).toBe("complete")
    expect(assistant?.contentBlocks.some((block) => block.type === "text")).toBe(true)

    storage.close()
  })
})

async function waitForTerminalEvent(eventStore: TurnEventStore, requestId: RequestId): Promise<void> {
  const startedAt = Date.now()
  while (!eventStore.getTerminalEvent(requestId)) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("等待 turn 终态事件超时。")
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
