import type { ModelDescriptor, ModelId, ModelRole, ProviderId } from "@ema-agent/core-types"

import type { ModelBinding, ModelBindingConfig } from "./types.js"

/**
 * 模型目录。
 *
 * 这一层只管理“本进程内可见的模型快照”和“角色绑定”，不直接访问 provider。
 * 远端刷新由 LlmRegistry 调 adapter 完成，然后把结果写回这里。
 */
export class ModelCatalog {
  private readonly models = new Map<string, ModelDescriptor>()
  private bindings: ModelBindingConfig = {}

  upsertMany(models: ModelDescriptor[]): void {
    for (const model of models) {
      this.models.set(model.id, model)
    }
  }

  list(providerId?: ProviderId): ModelDescriptor[] {
    const models = [...this.models.values()]

    if (!providerId) {
      return models
    }

    return models.filter((model) => model.providerId === providerId)
  }

  get(modelId: ModelId): ModelDescriptor | undefined {
    return this.models.get(modelId)
  }

  bindRole(binding: ModelBinding): void {
    this.bindings = {
      ...this.bindings,
      [binding.role]: binding,
    }
  }

  getBinding(role: ModelRole): ModelBinding | undefined {
    return this.bindings[role]
  }

  snapshotBindings(): ModelBindingConfig {
    return { ...this.bindings }
  }
}
