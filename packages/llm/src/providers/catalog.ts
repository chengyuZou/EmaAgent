import type { ProviderId } from "@ema-agent/core-types"

import type { LlmProviderSpec } from "./spec.js"

/** 运行时 provider 注册表，内存存储，支持 CRUD。 */
export class ProviderCatalog {
  private readonly store = new Map<ProviderId, LlmProviderSpec>()

  upsert(spec: LlmProviderSpec): void {
    this.store.set(spec.id, spec)
  }

  remove(id: ProviderId): void {
    this.store.delete(id)
  }

  get(id: ProviderId): LlmProviderSpec | undefined {
    return this.store.get(id)
  }

  list(): LlmProviderSpec[] {
    return [...this.store.values()]
  }

  listEnabled(): LlmProviderSpec[] {
    return this.list().filter(s => s.enabled)
  }

  has(id: ProviderId): boolean {
    return this.store.has(id)
  }
}
