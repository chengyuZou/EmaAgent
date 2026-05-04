import { describe, expect, it } from "vitest"

import { EbdBridgeClient } from "./bridge-client.js"

describe("EbdBridgeClient contract", () => {
  it("bridge 不可用时返回确定性 fallback embedding", async () => {
    const client = new EbdBridgeClient({
      fetch: async () => {
        throw new Error("bridge down")
      },
    })

    const result = await client.embed({ input: "hello" })

    expect(result.modelId).toBe("local-hash-embedding")
    expect(result.embeddings).toHaveLength(1)
    expect(result.dimensions).toBe(64)
  })
})
