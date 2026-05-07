import { describe, expect, it, vi, beforeEach } from "vitest"
import { asId } from "@ema-agent/core-types"
import type { ChatCompletionChunk, ModelId, ProviderId } from "@ema-agent/core-types"
import { LlmClient } from "../src/client.js"
import type { LlmProviderSpec } from "../src/providers/spec.js"

// Mock the stream/chat module so tests don't need a real API endpoint
vi.mock("../src/stream/chat.js", () => ({
  streamChat: vi.fn(),
}))

// Import after mock is registered
import { streamChat } from "../src/stream/chat.js"
const mockStreamChat = vi.mocked(streamChat)

function makeSpec(id: string, enabled = true): LlmProviderSpec {
  return {
    id: asId<ProviderId>(id),
    kind: "openai-compatible",
    displayName: id,
    enabled,
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: "sk-test",
  }
}

async function* makeChunkStream(...chunks: ChatCompletionChunk[]): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk
}

describe("LlmClient", () => {
  let client: LlmClient

  beforeEach(() => {
    client = new LlmClient()
    mockStreamChat.mockReset()
  })

  describe("provider management", () => {
    it("listProviders is empty on construction", () => {
      expect(client.listProviders()).toEqual([])
    })

    it("upsertProvider + listProviders roundtrip", () => {
      client.upsertProvider(makeSpec("openai"))
      expect(client.listProviders()).toHaveLength(1)
      expect(client.listProviders()[0].id).toBe("openai")
    })

    it("applyConfig loads multiple providers", () => {
      client.applyConfig({
        providers: [makeSpec("openai"), makeSpec("anthropic")],
      })
      expect(client.listProviders()).toHaveLength(2)
    })

    it("applyConfig is additive (upserts, not replaces)", () => {
      client.upsertProvider(makeSpec("ollama"))
      client.applyConfig({ providers: [makeSpec("openai")] })
      expect(client.listProviders()).toHaveLength(2)
    })

    it("removeProvider deletes the provider", () => {
      client.upsertProvider(makeSpec("openai"))
      client.removeProvider(asId<ProviderId>("openai"))
      expect(client.listProviders()).toHaveLength(0)
    })

    it("upsertProvider overwrites existing provider with same id", () => {
      client.upsertProvider(makeSpec("openai"))
      client.upsertProvider({ ...makeSpec("openai"), displayName: "OpenAI Updated" })
      expect(client.listProviders()).toHaveLength(1)
      expect(client.listProviders()[0].displayName).toBe("OpenAI Updated")
    })
  })

  describe("model management", () => {
    it("listModels is empty on construction", () => {
      expect(client.listModels()).toEqual([])
    })
  })

  describe("streamChat", () => {
    it("delegates to streamChat and yields chunks", async () => {
      client.upsertProvider(makeSpec("openai"))
      const expectedChunks: ChatCompletionChunk[] = [
        { index: 0, delta: { content: "Hello" }, finishReason: null },
        { index: 1, delta: {}, finishReason: "stop" },
      ]
      mockStreamChat.mockReturnValueOnce(makeChunkStream(...expectedChunks))

      const collected: ChatCompletionChunk[] = []
      for await (const chunk of client.streamChat({
        providerId: asId<ProviderId>("openai"),
        modelId: asId<ModelId>("gpt-4o-mini"),
        messages: [{ role: "user", content: "hi" }],
      })) {
        collected.push(chunk)
      }

      expect(collected).toHaveLength(2)
      expect(collected[0].delta.content).toBe("Hello")
      expect(collected[1].finishReason).toBe("stop")
    })

    it("passes all request fields to the underlying streamChat", async () => {
      client.upsertProvider(makeSpec("openai"))
      mockStreamChat.mockReturnValueOnce(makeChunkStream())

      const messages = [{ role: "user" as const, content: "test" }]
      await Array.fromAsync(
        client.streamChat({
          providerId: asId<ProviderId>("openai"),
          modelId: asId<ModelId>("gpt-4o"),
          messages,
          temperature: 0.7,
          maxTokens: 512,
        }),
      )

      expect(mockStreamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: "gpt-4o",
          messages,
          temperature: 0.7,
          maxTokens: 512,
        }),
      )
    })

    it("throws when provider not found", async () => {
      await expect(async () => {
        await Array.fromAsync(
          client.streamChat({
            providerId: asId<ProviderId>("nonexistent"),
            modelId: asId<ModelId>("gpt-4o"),
            messages: [],
          }),
        )
      }).rejects.toThrow('Provider not found: "nonexistent"')
    })

    it("throws when provider is disabled", async () => {
      client.upsertProvider(makeSpec("openai", false))
      await expect(async () => {
        await Array.fromAsync(
          client.streamChat({
            providerId: asId<ProviderId>("openai"),
            modelId: asId<ModelId>("gpt-4o"),
            messages: [],
          }),
        )
      }).rejects.toThrow('Provider "openai" is disabled.')
    })
  })
})
