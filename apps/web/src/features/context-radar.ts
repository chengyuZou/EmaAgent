import type { ContextRadarView } from "@ema-agent/memory"

import type { createMemoryApiClient } from "../api/memory.js"

type MemoryApiClient = ReturnType<typeof createMemoryApiClient>

export interface ContextRadarState {
  loading: boolean
  view?: ContextRadarView
  error?: string
}

/**
 * ContextRadar 控制器。
 *
 * 它只负责拉取和保存预算视图，UI 可以把 sourceStats 渲染成雷达图或列表。
 */
export function createContextRadarController(client: MemoryApiClient) {
  let state: ContextRadarState = { loading: false }
  const listeners = new Set<(state: ContextRadarState) => void>()

  const setState = (patch: Partial<ContextRadarState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  return {
    getState: () => state,
    subscribe(listener: (state: ContextRadarState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async load(input: { sessionId: string; query: string; mode: string; maxTokens?: number }) {
      setState({ loading: true, error: undefined })
      try {
        setState({ view: await client.getContextRadar(input) })
      } catch (error) {
        setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setState({ loading: false })
      }
    },
  }
}
