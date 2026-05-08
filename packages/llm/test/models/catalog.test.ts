import { describe, expect, it } from "vitest"
import { asId } from "@ema-agent/core-types"
import type { ModelId, ProviderId } from "@ema-agent/core-types"
import type { ModelDescriptor } from "@ema-agent/core-types"
import { ModelCatalog } from "../../src/models/catalog.js"



function makeModel(providerId: string, modelId: string): ModelDescriptor {
  return {
    id: asId<ModelId>(modelId),
    displayName: modelId,
    providerId: asId<ProviderId>(providerId),
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    source: "remote",
  }
}

describe("ModelCatalog", () => {
  it("starts empty", () => {
    const catalog = new ModelCatalog()
    expect(catalog.list()).toEqual([])
  })

  it("upsertMany + get roundtrip", () => {
    const catalog = new ModelCatalog()
    const m = makeModel("openai", "gpt-4o")
    catalog.upsertMany([m])
    expect(catalog.get(m.providerId, m.id)).toEqual(m)
  })

  it("upsertMany overwrites existing entry", () => {
    const catalog = new ModelCatalog()
    catalog.upsertMany([makeModel("openai", "gpt-4o")])
    const updated = { ...makeModel("openai", "gpt-4o"), displayName: "GPT-4o Updated" }
    catalog.upsertMany([updated])
    expect(catalog.get(updated.providerId, updated.id)?.displayName).toBe("GPT-4o Updated")
  })

  it("list() returns all models across providers", () => {
    const catalog = new ModelCatalog()
    catalog.upsertMany([makeModel("openai", "gpt-4o"), makeModel("anthropic", "claude-3")])
    expect(catalog.list()).toHaveLength(2)
  })

  it("list(providerId) filters by provider", () => {
    const catalog = new ModelCatalog()
    catalog.upsertMany([
      makeModel("openai", "gpt-4o"),
      makeModel("openai", "gpt-3.5-turbo"),
      makeModel("anthropic", "claude-3"),
    ])
    const openaiModels = catalog.list(asId<ProviderId>("openai"))
    expect(openaiModels).toHaveLength(2)
    expect(openaiModels.every(m => m.providerId === "openai")).toBe(true)
  })

  it("removeByProvider removes only that provider's models", () => {
    const catalog = new ModelCatalog()
    catalog.upsertMany([
      makeModel("openai", "gpt-4o"),
      makeModel("anthropic", "claude-3"),
    ])
    catalog.removeByProvider(asId<ProviderId>("openai"))
    expect(catalog.list()).toHaveLength(1)
    expect(catalog.list()[0].providerId).toBe("anthropic")
  })

  it("get returns undefined for missing model", () => {
    const catalog = new ModelCatalog()
    expect(catalog.get(asId<ProviderId>("openai"), asId<ModelId>("gpt-4o"))).toBeUndefined()
  })

  it("upsertMany with empty array is a no-op", () => {
    const catalog = new ModelCatalog()
    expect(() => catalog.upsertMany([])).not.toThrow()
    expect(catalog.list()).toHaveLength(0)
  })
})
