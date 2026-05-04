import type { ModelDescriptor, ModelRole, ProviderDescriptor, ProviderHealthView } from "@ema-agent/core-types"
import type { LlmProviderConfig, ModelBindingConfig } from "@ema-agent/llm"

import type { createLlmApiClient } from "../api/llm.js"

type LlmApiClient = ReturnType<typeof createLlmApiClient>

export interface ProviderSettingsState {
  loading: boolean
  saving: boolean
  providers: ProviderDescriptor[]
  providerConfigs: LlmProviderConfig[]
  models: ModelDescriptor[]
  bindings: ModelBindingConfig
  healthByProviderId: Record<string, ProviderHealthView>
  selectedProviderId?: string
  error?: string
}

export interface ProviderSettingsController {
  getState(): ProviderSettingsState
  subscribe(listener: (state: ProviderSettingsState) => void): () => void
  load(): Promise<void>
  selectProvider(providerId: string): Promise<void>
  updateProvider(providerId: string, patch: Partial<LlmProviderConfig>): Promise<void>
  refreshModels(providerId: string): Promise<void>
  checkHealth(providerId: string): Promise<void>
  bindModel(input: { role: ModelRole; providerId: string; modelId: string }): Promise<void>
}

/**
 * Provider 设置页的 headless UI controller。
 *
 * 页面组件只负责渲染 state；所有加载、保存、刷新、绑定逻辑集中在这里。
 */
export function createProviderSettingsController(client: LlmApiClient): ProviderSettingsController {
  let state: ProviderSettingsState = {
    loading: false,
    saving: false,
    providers: [],
    providerConfigs: [],
    models: [],
    bindings: {},
    healthByProviderId: {},
  }
  const listeners = new Set<(state: ProviderSettingsState) => void>()

  const setState = (patch: Partial<ProviderSettingsState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      listener(state)
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },

    async load() {
      await runWithLoading(setState, async () => {
        const [config, providers, models, bindings] = await Promise.all([
          client.getConfig(),
          client.listProviders(),
          client.listModels(),
          client.getBindings(),
        ])
        setState({
          providers,
          providerConfigs: config.providers,
          models,
          bindings,
          selectedProviderId: state.selectedProviderId ?? providers[0]?.id,
        })
      })
    },

    async selectProvider(providerId) {
      setState({ selectedProviderId: providerId })
      if (!state.models.some((model) => model.providerId === providerId)) {
        await this.refreshModels(providerId)
      }
    },

    async updateProvider(providerId, patch) {
      await runWithSaving(setState, async () => {
        await client.updateProvider(providerId, patch)
        const config = await client.getConfig()
        const providers = await client.listProviders()
        setState({
          providerConfigs: config.providers,
          providers,
        })
      })
    },

    async refreshModels(providerId) {
      await runWithLoading(setState, async () => {
        const providerModels = await client.refreshModels(providerId)
        const otherModels = state.models.filter((model) => model.providerId !== providerId)
        setState({ models: [...otherModels, ...providerModels] })
      })
    },

    async checkHealth(providerId) {
      const health = await client.checkHealth(providerId)
      setState({
        healthByProviderId: {
          ...state.healthByProviderId,
          [providerId]: health,
        },
      })
    },

    async bindModel(input) {
      await runWithSaving(setState, async () => {
        await client.bindModel(input)
        setState({ bindings: await client.getBindings() })
      })
    },
  }
}

async function runWithLoading(setState: (patch: Partial<ProviderSettingsState>) => void, fn: () => Promise<void>): Promise<void> {
  setState({ loading: true, error: undefined })
  try {
    await fn()
  } catch (error) {
    setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    setState({ loading: false })
  }
}

async function runWithSaving(setState: (patch: Partial<ProviderSettingsState>) => void, fn: () => Promise<void>): Promise<void> {
  setState({ saving: true, error: undefined })
  try {
    await fn()
  } catch (error) {
    setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    setState({ saving: false })
  }
}
