import type { NarrativeBridgeResult } from "@ema-agent/core-types"

import type { createNarrativeApiClient } from "../api/narrative.js"

type NarrativeApiClient = ReturnType<typeof createNarrativeApiClient>

export interface NarrativeRecallState {
  loading: boolean
  result?: NarrativeBridgeResult
  error?: string
}

/**
 * Narrative recall panel 控制器。
 *
 * narrative 模式里可以把召回 chunks 原样展示给用户检查，避免模型隐式使用剧情上下文。
 */
export function createNarrativeRecallController(client: NarrativeApiClient) {
  let state: NarrativeRecallState = { loading: false }
  const listeners = new Set<(state: NarrativeRecallState) => void>()

  const setState = (patch: Partial<NarrativeRecallState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  return {
    getState: () => state,
    subscribe(listener: (state: NarrativeRecallState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async query(input: { worldId: string; sceneContext: string; query: string }) {
      setState({ loading: true, error: undefined })
      try {
        setState({ result: await client.query(input) })
      } catch (error) {
        setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setState({ loading: false })
      }
    },
  }
}
