import { describe, expect, it } from "vitest"
import { asId } from "@ema-agent/core-types"
import type { ProviderId } from "@ema-agent/core-types"
import { ProviderCatalog } from "../../src/providers/catalog.js"
import type { LlmProviderSpec } from "../../src/providers/spec.js"

function makeSpec(id: string, enabled = true): LlmProviderSpec {
  return {
    id: asId<ProviderId>(id),
    kind: "openai-compatible",
    displayName: id,
    enabled,
    baseUrl: `https://${id}.example.com/v1`,
  }
}

describe("ProviderCatalog", () => {
  it("starts empty", () => {
    const catalog = new ProviderCatalog()
    expect(catalog.list()).toEqual([])
  })

  it("upsert + get roundtrip", () => {
    const catalog = new ProviderCatalog()
    const spec = makeSpec("openai")
    catalog.upsert(spec)
    expect(catalog.get(spec.id)).toEqual(spec)
  })

  it("upsert overwrites on same id", () => {
    const catalog = new ProviderCatalog()
    catalog.upsert(makeSpec("openai"))
    const updated = { ...makeSpec("openai"), displayName: "Updated" }
    catalog.upsert(updated)
    expect(catalog.get(updated.id)?.displayName).toBe("Updated")
    expect(catalog.list()).toHaveLength(1)
  })

  it("remove deletes entry", () => {
    const catalog = new ProviderCatalog()
    const spec = makeSpec("openai")
    catalog.upsert(spec)
    catalog.remove(spec.id)
    expect(catalog.get(spec.id)).toBeUndefined()
    expect(catalog.list()).toHaveLength(0)
  })

  it("has returns correct presence", () => {
    const catalog = new ProviderCatalog()
    const spec = makeSpec("openai")
    expect(catalog.has(spec.id)).toBe(false)
    catalog.upsert(spec)
    expect(catalog.has(spec.id)).toBe(true)
  })

  it("list returns all entries", () => {
    const catalog = new ProviderCatalog()
    catalog.upsert(makeSpec("openai"))
    catalog.upsert(makeSpec("anthropic"))
    expect(catalog.list()).toHaveLength(2)
  })

  it("listEnabled filters disabled providers", () => {
    const catalog = new ProviderCatalog()
    catalog.upsert(makeSpec("openai", true))
    catalog.upsert(makeSpec("anthropic", false))
    const enabled = catalog.listEnabled()
    expect(enabled).toHaveLength(1)
    expect(enabled[0].id).toBe("openai")
  })

  it("remove on unknown id is a no-op", () => {
    const catalog = new ProviderCatalog()
    expect(() => catalog.remove(asId<ProviderId>("nonexistent"))).not.toThrow()
  })
})
