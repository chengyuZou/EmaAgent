import type { TelemetryEventView, createTelemetryApiClient } from "../api/telemetry.js"

type TelemetryApiClient = ReturnType<typeof createTelemetryApiClient>

export interface EventInspectorState {
  loading: boolean
  items: TelemetryEventView[]
  error?: string
}

/**
 * Developer Event Inspector 控制器。
 *
 * 用于 05-27 的 trace/log/event inspector，不影响普通聊天界面。
 */
export function createEventInspectorController(client: TelemetryApiClient) {
  let state: EventInspectorState = { loading: false, items: [] }
  const listeners = new Set<(state: EventInspectorState) => void>()

  const setState = (patch: Partial<EventInspectorState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  return {
    getState: () => state,
    subscribe(listener: (state: EventInspectorState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async loadRecent(limit = 50) {
      setState({ loading: true, error: undefined })
      try {
        setState({ items: await client.listRecent(limit) })
      } catch (error) {
        setState({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setState({ loading: false })
      }
    },
  }
}
