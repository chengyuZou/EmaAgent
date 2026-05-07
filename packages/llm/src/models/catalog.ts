import type { ModelDescriptor, ModelId, ProviderId } from "@ema-agent/core-types"

/** 运行时模型目录，按 providerId 分组缓存远端拉取的模型列表。 */
export class ModelCatalog {
  /** key = `${providerId}::${modelId}` */
  private readonly store = new Map<string, ModelDescriptor>()

  upsertMany(models: ModelDescriptor[]): void {
    for (const m of models) {
      this.store.set(key(m.providerId, m.id), m)
    }
  }

  get(providerId: ProviderId, modelId: ModelId): ModelDescriptor | undefined {
    return this.store.get(key(providerId, modelId))
  }

  list(providerId?: ProviderId): ModelDescriptor[] {
    const all = [...this.store.values()]
    return providerId ? all.filter(m => m.providerId === providerId) : all
  }

  removeByProvider(providerId: ProviderId): void {
    for (const [k] of this.store) {
      if (k.startsWith(`${providerId}::`)) this.store.delete(k)
    }
  }
}

function key(providerId: ProviderId, modelId: ModelId): string {
  return `${providerId}::${modelId}`
}
