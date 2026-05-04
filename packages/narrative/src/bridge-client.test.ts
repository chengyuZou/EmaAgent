import { describe, expect, it } from "vitest"

import { NarrativeBridgeClient } from "./bridge-client.js"

describe("NarrativeBridgeClient contract", () => {
  it("bridge 不可用时返回空召回结果而不是抛错", async () => {
    const client = new NarrativeBridgeClient({
      fetch: async () => {
        throw new Error("bridge down")
      },
    })

    const result = await client.query({
      worldId: "default",
      sceneContext: "",
      query: "test",
    })

    expect(result.chunks).toEqual([])
    expect(result.deduped).toBe(true)
  })
})
