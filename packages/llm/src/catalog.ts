import type { ModelDescriptor, ModelId, ModelRole, ProviderId } from "@ema-agent/core-types"

import type { ModelBinding, ModelBindingConfig } from "./types.js"

/**
 * 模型目录骨架。
 *
 * 这里先只保留调用面。具体的内存索引、远端刷新合并、持久化策略后面再写。
 */
export class ModelCatalog {
  upsertMany(models: ModelDescriptor[]): void {
    void models
  }

  list(providerId?: ProviderId): ModelDescriptor[] {
    void providerId
    return []
  }

  get(modelId: ModelId): ModelDescriptor | undefined {
    void modelId
    return undefined
  }

  bindRole(binding: ModelBinding): void {
    void binding
  }

  getBinding(role: ModelRole): ModelBinding | undefined {
    void role
    return undefined
  }

  snapshotBindings(): ModelBindingConfig {
    return {}
  }
}
